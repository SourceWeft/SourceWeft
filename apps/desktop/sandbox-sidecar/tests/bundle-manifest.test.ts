import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildManifest,
  bunCompileTarget,
  resolveTarget,
} from "../scripts/manifest.js";

function bundle(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sw-manifest-"));
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(dir, name), body);
  return dir;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const base = {
  protocolVersion: 3,
  appVersion: "0.3.0-rc.9",
  target: "x86_64-unknown-linux-gnu",
  srtVersion: "0.0.81",
};

test("manifest lists sha256 and size of every file except manifest.json, sorted by name", () => {
  const dir = bundle({
    rg: "ripgrep",
    "srt-sidecar": "side",
    "manifest.json": "stale",
  });
  try {
    const manifest = buildManifest({ ...base, bundleDir: dir });
    assert.deepEqual(manifest, {
      schemaVersion: 1,
      protocolVersion: 3,
      appVersion: "0.3.0-rc.9",
      target: "x86_64-unknown-linux-gnu",
      srtVersion: "0.0.81",
      files: {
        rg: { sha256: sha("ripgrep"), size: 7 },
        "srt-sidecar": { sha256: sha("side"), size: 4 },
      },
    });
    assert.deepEqual(Object.keys(manifest.files), ["rg", "srt-sidecar"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest refuses links and sub-directories in the bundle", () => {
  const dir = bundle({ rg: "x" });
  try {
    symlinkSync(join(dir, "rg"), join(dir, "link"));
    assert.throws(
      () => buildManifest({ ...base, bundleDir: dir }),
      /regular file/,
    );
    rmSync(join(dir, "link"));
    mkdirSync(join(dir, "sub"));
    assert.throws(
      () => buildManifest({ ...base, bundleDir: dir }),
      /regular file/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest refuses an empty bundle and invalid inputs", () => {
  const dir = bundle({});
  try {
    assert.throws(() => buildManifest({ ...base, bundleDir: dir }), /no files/);
    writeFileSync(join(dir, "rg"), "x");
    assert.throws(
      () => buildManifest({ ...base, appVersion: "latest", bundleDir: dir }),
      /appVersion/,
    );
    assert.throws(
      () => buildManifest({ ...base, protocolVersion: 0, bundleDir: dir }),
      /protocolVersion/,
    );
    assert.throws(
      () => buildManifest({ ...base, srtVersion: "", bundleDir: dir }),
      /srtVersion/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("target: explicit value must be for the build host OS; no guessing otherwise", () => {
  assert.equal(
    resolveTarget(undefined, "linux", "x64"),
    "x86_64-unknown-linux-gnu",
  );
  assert.equal(
    resolveTarget("x86_64-unknown-linux-gnu", "linux", "x64"),
    "x86_64-unknown-linux-gnu",
  );
  assert.equal(
    resolveTarget("aarch64-apple-darwin", "darwin", "arm64"),
    "aarch64-apple-darwin",
  );
  assert.equal(
    resolveTarget("aarch64-unknown-linux-gnu", "linux", "arm64"),
    "aarch64-unknown-linux-gnu",
  );
  // Same-OS cross-architecture is allowed: macOS builds x86_64 on the arm64 runner.
  assert.equal(
    resolveTarget("x86_64-apple-darwin", "darwin", "arm64"),
    "x86_64-apple-darwin",
  );
  // Not the Linux x64 default: --target is mandatory.
  assert.throws(() => resolveTarget(undefined, "darwin", "arm64"), /--target/);
  assert.throws(() => resolveTarget(undefined, "linux", "arm64"), /--target/);
  // The sidecar is compiled for the host OS only; a cross-OS or unknown triple is refused.
  assert.throws(
    () => resolveTarget("aarch64-apple-darwin", "linux", "x64"),
    /host OS/,
  );
  assert.throws(
    () => resolveTarget("x86_64-unknown-linux-gnu", "darwin", "arm64"),
    /host OS/,
  );
  assert.throws(
    () => resolveTarget("x86_64-pc-windows-msvc", "win32", "x64"),
    /not a supported/,
  );
  assert.throws(
    () => resolveTarget("bogus", "linux", "x64"),
    /not a supported/,
  );
});

test("bunCompileTarget: undefined for a native build, explicit for same-OS cross", () => {
  // Native builds compile with no --target (byte-identical to the historical build).
  assert.equal(
    bunCompileTarget("x86_64-unknown-linux-gnu", "linux", "x64"),
    undefined,
  );
  assert.equal(
    bunCompileTarget("aarch64-apple-darwin", "darwin", "arm64"),
    undefined,
  );
  // macOS x86_64 on the arm64 runner cross-compiles with an explicit Bun target.
  assert.equal(
    bunCompileTarget("x86_64-apple-darwin", "darwin", "arm64"),
    "bun-darwin-x64",
  );
});
