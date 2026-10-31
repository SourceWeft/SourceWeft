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
  bundlePlan,
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
    () => resolveTarget("bogus", "linux", "x64"),
    /not a supported/,
  );
});

test("target: Windows triples are accepted on a Windows host only, and --target is mandatory there", () => {
  assert.equal(
    resolveTarget("x86_64-pc-windows-msvc", "win32", "x64"),
    "x86_64-pc-windows-msvc",
  );
  assert.equal(
    resolveTarget("aarch64-pc-windows-msvc", "win32", "arm64"),
    "aarch64-pc-windows-msvc",
  );
  // Same-OS cross-architecture, as on macOS: the x64 runner may build the arm64 bundle.
  assert.equal(
    resolveTarget("aarch64-pc-windows-msvc", "win32", "x64"),
    "aarch64-pc-windows-msvc",
  );
  assert.throws(() => resolveTarget(undefined, "win32", "x64"), /--target/);
  assert.throws(() => resolveTarget(undefined, "win32", "arm64"), /--target/);
  // A Windows binary is never built on another OS, and a non-Windows triple never on Windows.
  for (const [platform, arch] of [
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "arm64"],
    ["darwin", "x64"],
  ] as const) {
    assert.throws(
      () => resolveTarget("x86_64-pc-windows-msvc", platform, arch),
      /host OS/,
      `${platform}/${arch}`,
    );
  }
  assert.throws(
    () => resolveTarget("x86_64-unknown-linux-gnu", "win32", "x64"),
    /host OS/,
  );
  assert.throws(
    () => resolveTarget("aarch64-apple-darwin", "win32", "arm64"),
    /host OS/,
  );
  // Only the MSVC triples exist; no gnu/other Windows flavour and no 32-bit.
  assert.throws(
    () => resolveTarget("x86_64-pc-windows-gnu", "win32", "x64"),
    /not a supported/,
  );
  assert.throws(
    () => resolveTarget("i686-pc-windows-msvc", "win32", "x64"),
    /not a supported/,
  );
  // A host with an unsupported architecture is refused rather than guessed.
  assert.throws(
    () => resolveTarget("x86_64-pc-windows-msvc", "win32", "ia32"),
    /host OS/,
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

test("bunCompileTarget: native Windows builds omit --target, cross-arch passes the Bun windows target", () => {
  assert.equal(
    bunCompileTarget("x86_64-pc-windows-msvc", "win32", "x64"),
    undefined,
  );
  assert.equal(
    bunCompileTarget("aarch64-pc-windows-msvc", "win32", "arm64"),
    undefined,
  );
  assert.equal(
    bunCompileTarget("aarch64-pc-windows-msvc", "win32", "x64"),
    "bun-windows-arm64",
  );
  assert.equal(
    bunCompileTarget("x86_64-pc-windows-msvc", "win32", "arm64"),
    "bun-windows-x64",
  );
});

const VENDOR = "node_modules/@anthropic-ai/sandbox-runtime/vendor";
const JAR = {
  from: `${VENDOR}/java-proxy-agent/srt-proxy-agent.jar`,
  to: "srt-proxy-agent.jar",
  executable: false,
};

test("bundlePlan: the Windows bundle is sidecar.exe + rg.exe + srt-win.exe + jar, with no apply-seccomp", () => {
  for (const [target, arch] of [
    ["x86_64-pc-windows-msvc", "x64"],
    ["aarch64-pc-windows-msvc", "arm64"],
  ] as const) {
    const plan = bundlePlan(target);
    assert.equal(plan.sidecarName, "srt-sidecar.exe");
    assert.equal(plan.rgName, "rg.exe");
    // srt-win comes from the TARGET architecture's vendor directory (the runner is the
    // sandbox account's own process, so it must match the bundle's architecture).
    assert.deepEqual(plan.vendorCopies, [
      {
        from: `${VENDOR}/srt-win/${arch}/srt-win.exe`,
        to: "srt-win.exe",
        executable: false,
      },
      JAR,
    ]);
    assert.equal(plan.setExecBit, false);
    assert(!JSON.stringify(plan).includes("seccomp"));
  }
});

test("bundlePlan: Linux and macOS bundles keep their historical file sets", () => {
  const linuxX64 = bundlePlan("x86_64-unknown-linux-gnu");
  assert.equal(linuxX64.sidecarName, "srt-sidecar");
  assert.equal(linuxX64.rgName, "rg");
  assert.equal(linuxX64.setExecBit, true);
  assert.deepEqual(linuxX64.vendorCopies, [
    {
      from: `${VENDOR}/seccomp/x64/apply-seccomp`,
      to: "apply-seccomp",
      executable: true,
    },
    JAR,
  ]);
  assert.deepEqual(bundlePlan("aarch64-unknown-linux-gnu").vendorCopies[0], {
    from: `${VENDOR}/seccomp/arm64/apply-seccomp`,
    to: "apply-seccomp",
    executable: true,
  });
  for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const plan = bundlePlan(target);
    assert.equal(plan.sidecarName, "srt-sidecar");
    assert.equal(plan.rgName, "rg");
    assert.equal(plan.setExecBit, true);
    assert.deepEqual(plan.vendorCopies, [JAR]);
  }
  assert.throws(() => bundlePlan("riscv64-unknown-linux-gnu"), /not a supported/);
  assert.throws(() => bundlePlan("x86_64-pc-windows-gnu"), /not a supported/);
});

test("manifest over a Windows file set lists the .exe names, sorted, with sha256 and size", () => {
  const dir = bundle({
    "srt-sidecar.exe": "side",
    "rg.exe": "ripgrep",
    "srt-win.exe": "runner",
    "srt-proxy-agent.jar": "jar",
    "manifest.json": "stale",
  });
  try {
    const manifest = buildManifest({
      ...base,
      target: "x86_64-pc-windows-msvc",
      bundleDir: dir,
    });
    assert.equal(manifest.target, "x86_64-pc-windows-msvc");
    assert.deepEqual(Object.keys(manifest.files), [
      "rg.exe",
      "srt-proxy-agent.jar",
      "srt-sidecar.exe",
      "srt-win.exe",
    ]);
    assert.deepEqual(manifest.files["srt-win.exe"], {
      sha256: sha("runner"),
      size: 6,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
