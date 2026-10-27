import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { packBundle, verifyTarball, writeTar } from "./sandbox-bundle.mjs";

const script = fileURLToPath(new URL("./sandbox-bundle.mjs", import.meta.url));
const TARGET = "x86_64-unknown-linux-gnu";
const TARBALL = `sourceweft-sandbox-${TARGET}.tar.gz`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const FILES = {
  "srt-sidecar": { body: "#!sidecar\n" + "x".repeat(1500), exec: true },
  rg: { body: "ripgrep binary", exec: true },
  "apply-seccomp": { body: "seccomp", exec: true },
  "srt-proxy-agent.jar": { body: "PK\u0003\u0004jar", exec: false },
};

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-bundle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function manifestFor(files, overrides = {}) {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    appVersion: "0.3.0-rc.9",
    target: TARGET,
    srtVersion: "0.0.81",
    files: Object.fromEntries(
      Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, { body }]) => [
          name,
          { sha256: sha(body), size: Buffer.byteLength(body) },
        ]),
    ),
    ...overrides,
  };
}

async function makeBundle(
  t,
  { files = FILES, manifest = manifestFor(files) } = {},
) {
  const dir = join(await temp(t), "bundle");
  await mkdir(dir);
  for (const [name, { body, exec }] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
    await chmod(join(dir, name), exec ? 0o755 : 0o644);
  }
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return dir;
}

// ---- independent raw ustar builder, so hostile archives do not depend on the script's writer
function rawEntry({
  name,
  body = "",
  type = "0",
  link = "",
  mode = 0o644,
  prefix = "",
}) {
  const data = Buffer.from(body);
  const block = Buffer.alloc(512);
  block.write(name, 0, "latin1");
  block.write(mode.toString(8).padStart(7, "0") + "\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write(link, 157, "latin1");
  block.write("ustar\0", 257);
  block.write("00", 263);
  block.write(prefix, 345, "latin1");
  let sum = 0;
  for (const b of block) sum += b;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([block, data, pad]);
}
const rawTar = (entries) =>
  Buffer.concat([...entries.map(rawEntry), Buffer.alloc(1024)]);

function goodEntries(files = FILES, manifest = manifestFor(files)) {
  return [
    { name: "manifest.json", body: JSON.stringify(manifest, null, 2) + "\n" },
    ...Object.entries(files)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, { body, exec }]) => ({
        name,
        body,
        mode: exec ? 0o755 : 0o644,
      })),
  ];
}

async function writeArchive(t, entries, name = TARBALL) {
  const path = join(await temp(t), name);
  await writeFile(path, gzipSync(rawTar(entries)));
  return path;
}

test("the hand-built reference archive verifies (sanity for the hostile cases below)", async (t) => {
  const manifest = await verifyTarball(await writeArchive(t, goodEntries()));
  assert.equal(manifest.target, TARGET);
});

test("pack is deterministic: equal bytes regardless of mtime, creation order or output dir", async (t) => {
  const bundle = await makeBundle(t);
  const first = await packBundle(bundle, join(await temp(t), "out1"));
  assert.equal(first.endsWith(TARBALL), true);
  const before = await readFile(first);
  const later = new Date(Date.now() + 86_400_000);
  for (const name of [...Object.keys(FILES), "manifest.json"])
    await utimes(join(bundle, name), later, later);
  const second = await packBundle(bundle, join(await temp(t), "out2"));
  assert.deepEqual(await readFile(second), before);
  // A bundle written in a different order packs to the same bytes.
  const reversed = Object.fromEntries(Object.entries(FILES).reverse());
  const other = await makeBundle(t, {
    files: reversed,
    manifest: manifestFor(FILES),
  });
  assert.deepEqual(
    await readFile(await packBundle(other, join(await temp(t), "out3"))),
    before,
  );
});

test("packed archive layout: manifest first, sorted, zeroed metadata, modes 0755/0644", async (t) => {
  const bundle = await makeBundle(t);
  const path = await packBundle(bundle, join(await temp(t), "out"));
  const manifest = await verifyTarball(path);
  assert.deepEqual(Object.keys(manifest.files), [
    "apply-seccomp",
    "rg",
    "srt-proxy-agent.jar",
    "srt-sidecar",
  ]);
  const { gunzipSync } = await import("node:zlib");
  const tar = gunzipSync(await readFile(path));
  const names = [];
  for (let offset = 0; tar[offset] !== 0;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.toString("latin1", 0, header.indexOf(0));
    names.push(name);
    const octal = (from, len) =>
      Number.parseInt(
        header.toString("latin1", from, from + len).replace(/\0.*/, ""),
        8,
      );
    assert.equal(octal(108, 8), 0, "uid");
    assert.equal(octal(116, 8), 0, "gid");
    assert.equal(octal(136, 12), 0, "mtime");
    assert.equal(
      octal(100, 8),
      name.endsWith(".jar") || name === "manifest.json" ? 0o644 : 0o755,
      name,
    );
    assert.equal(
      header.toString("latin1", 265, 297).replace(/\0/g, ""),
      "",
      "uname",
    );
    offset += 512 + Math.ceil(octal(124, 12) / 512) * 512;
  }
  assert.deepEqual(names, [
    "manifest.json",
    "apply-seccomp",
    "rg",
    "srt-proxy-agent.jar",
    "srt-sidecar",
  ]);
  assert.equal(
    gunzipSync.length >= 0 && (await readFile(path))[9],
    3,
    "gzip OS byte is pinned",
  );
});

test("pack refuses a bundle that does not match its manifest", async (t) => {
  const tampered = await makeBundle(t);
  await writeFile(join(tampered, "rg"), "evil rg binary");
  await assert.rejects(
    packBundle(tampered, join(await temp(t), "o")),
    /size mismatch|sha256 mismatch/,
  );

  const sameSize = await makeBundle(t);
  await writeFile(
    join(sameSize, "rg"),
    "X".repeat(Buffer.byteLength(FILES.rg.body)),
  );
  await assert.rejects(
    packBundle(sameSize, join(await temp(t), "o")),
    /sha256 mismatch: rg/,
  );

  const extra = await makeBundle(t);
  await writeFile(join(extra, "unlisted"), "x");
  await assert.rejects(
    packBundle(extra, join(await temp(t), "o")),
    /file set differs/,
  );

  const missing = await makeBundle(t, {
    manifest: manifestFor({ ...FILES, extra: { body: "x" } }),
  });
  await assert.rejects(
    packBundle(missing, join(await temp(t), "o")),
    /file set differs/,
  );
});

test("pack refuses links and sub-directories in the bundle directory", async (t) => {
  const withLink = await makeBundle(t);
  await symlink(join(withLink, "rg"), join(withLink, "link"));
  await assert.rejects(
    packBundle(withLink, join(await temp(t), "o")),
    /not a regular file/,
  );
  const withDir = await makeBundle(t);
  await mkdir(join(withDir, "sub"));
  await assert.rejects(
    packBundle(withDir, join(await temp(t), "o")),
    /not a regular file/,
  );
});

test("pack requires a valid manifest", async (t) => {
  const badSchema = await makeBundle(t, {
    manifest: manifestFor(FILES, { schemaVersion: 2 }),
  });
  await assert.rejects(
    packBundle(badSchema, join(await temp(t), "o")),
    /schemaVersion/,
  );
  const badTarget = await makeBundle(t, {
    manifest: manifestFor(FILES, { target: "../evil" }),
  });
  await assert.rejects(
    packBundle(badTarget, join(await temp(t), "o")),
    /target/,
  );
  const noProtocol = manifestFor(FILES);
  delete noProtocol.protocolVersion;
  await assert.rejects(
    packBundle(
      await makeBundle(t, { manifest: noProtocol }),
      join(await temp(t), "o"),
    ),
    /unexpected keys/,
  );
});

test("verify accepts a packed bundle and returns its manifest", async (t) => {
  const path = await packBundle(
    await makeBundle(t),
    join(await temp(t), "out"),
  );
  const manifest = await verifyTarball(path);
  assert.equal(manifest.appVersion, "0.3.0-rc.9");
  assert.equal(manifest.files.rg.sha256, sha(FILES.rg.body));
});

test("verify detects tampering with any content byte, even when the tar is re-gzipped validly", async (t) => {
  const path = await packBundle(
    await makeBundle(t),
    join(await temp(t), "out"),
  );
  const { gunzipSync } = await import("node:zlib");
  const tar = gunzipSync(await readFile(path));
  const at = tar.indexOf("ripgrep binary");
  assert(at > 0);
  const flipped = Buffer.from(tar);
  flipped[at] ^= 1;
  const out = join(await temp(t), TARBALL);
  await writeFile(out, gzipSync(flipped));
  await assert.rejects(verifyTarball(out), /sha256 mismatch: rg/);
  // Corrupt compressed stream.
  const raw = Buffer.from(await readFile(path));
  raw[Math.floor(raw.length / 2)] ^= 0xff;
  const corrupt = join(await temp(t), TARBALL);
  await writeFile(corrupt, raw);
  await assert.rejects(verifyTarball(corrupt));
  // Truncated.
  const cut = join(await temp(t), TARBALL);
  await writeFile(cut, raw.subarray(0, 40));
  await assert.rejects(verifyTarball(cut));
});

test("verify rejects hostile archive entries, each for its own reason", async (t) => {
  const good = goodEntries();
  const withMode = (mode) =>
    good.map((entry) => (entry.name === "rg" ? { ...entry, mode } : entry));
  const cases = [
    [
      "path traversal",
      [...good, { name: "../escape", body: "x" }],
      /unsafe entry name/,
    ],
    [
      "absolute path",
      [...good, { name: "/etc/passwd", body: "x" }],
      /unsafe entry name/,
    ],
    [
      "nested path",
      [...good, { name: "dir/file", body: "x" }],
      /unsafe entry name/,
    ],
    [
      "dot entry",
      [...good, { name: ".", type: "5", mode: 0o755 }],
      /unexpected tar entry type|unsafe entry name/,
    ],
    [
      "directory entry",
      [...good, { name: "sub", type: "5", mode: 0o755 }],
      /unexpected tar entry type/,
    ],
    [
      "symlink entry",
      [...good, { name: "link", type: "2", link: "/etc/passwd" }],
      /unexpected tar entry type/,
    ],
    [
      "hard link entry",
      [...good, { name: "hard", type: "1", link: "rg" }],
      /unexpected tar entry type/,
    ],
    [
      "character device",
      [...good, { name: "dev", type: "3" }],
      /unexpected tar entry type/,
    ],
    [
      "pax header",
      [...good, { name: "pax", type: "x", body: "30 path=../x\n" }],
      /unexpected tar entry type/,
    ],
    [
      "gnu long name",
      [...good, { name: "long", type: "L", body: "../x\0" }],
      /unexpected tar entry type/,
    ],
    [
      "path prefix",
      [...good, { name: "evil", body: "x", prefix: "../up" }],
      /path prefix/,
    ],
    [
      "link target on a plain file",
      [...good, { name: "evil", body: "x", link: "/etc/passwd" }],
      /link target/,
    ],
    ["setuid mode", withMode(0o4755), /unexpected mode/],
    ["world-writable mode", withMode(0o777), /unexpected mode/],
    ["duplicate names", [...good, good[1]], /duplicate entry/],
    ["extra file", [...good, { name: "extra", body: "x" }], /file set differs/],
    [
      "missing file",
      good.filter((entry) => entry.name !== "rg"),
      /file set differs/,
    ],
    [
      "manifest not first",
      [...good.slice(1), good[0]],
      /must be the first entry/,
    ],
    ["no manifest", good.slice(1), /must be the first entry/],
  ];
  for (const [label, entries, pattern] of cases) {
    await assert.rejects(
      verifyTarball(await writeArchive(t, entries)),
      pattern,
      label,
    );
  }
});

test("verify rejects a manifest that disagrees with the files", async (t) => {
  const lying = manifestFor(FILES);
  lying.files.rg.sha256 = "0".repeat(64);
  await assert.rejects(
    verifyTarball(await writeArchive(t, goodEntries(FILES, lying))),
    /sha256 mismatch: rg/,
  );
  const wrongSize = manifestFor(FILES);
  wrongSize.files.rg.size += 1;
  await assert.rejects(
    verifyTarball(await writeArchive(t, goodEntries(FILES, wrongSize))),
    /size mismatch: rg/,
  );
  const selfListed = manifestFor(FILES);
  selfListed.files["manifest.json"] = { sha256: "0".repeat(64), size: 1 };
  await assert.rejects(
    verifyTarball(await writeArchive(t, goodEntries(FILES, selfListed))),
    /must not list itself/,
  );
  const upper = manifestFor(FILES);
  upper.files.rg.sha256 = upper.files.rg.sha256.toUpperCase();
  await assert.rejects(
    verifyTarball(await writeArchive(t, goodEntries(FILES, upper))),
    /lowercase hex/,
  );
  const wrongName = await writeArchive(
    t,
    goodEntries(),
    "sourceweft-sandbox-aarch64-apple-darwin.tar.gz",
  );
  await assert.rejects(
    verifyTarball(wrongName),
    /does not match the manifest target/,
  );
});

test("verify rejects structural tar damage: bad checksum, trailing data, no end marker", async (t) => {
  const tar = rawTar(goodEntries());
  const badChecksum = Buffer.from(tar);
  badChecksum[0] ^= 1; // name byte changes, checksum no longer matches
  const dir = await temp(t);
  const write = async (name, bytes) => {
    const path = join(dir, name, TARBALL);
    await mkdir(join(dir, name));
    await writeFile(path, bytes);
    return path;
  };
  await assert.rejects(
    verifyTarball(await write("a", gzipSync(badChecksum))),
    /checksum/,
  );
  await assert.rejects(
    verifyTarball(
      await write("b", gzipSync(Buffer.concat([tar, Buffer.from("junk")]))),
    ),
    /end marker|trailing/,
  );
  await assert.rejects(
    verifyTarball(
      await write("c", gzipSync(tar.subarray(0, tar.length - 1024))),
    ),
    /truncated/,
  );
  await assert.rejects(
    verifyTarball(await write("d", gzipSync(Buffer.alloc(0)))),
    /truncated/,
  );
});

test("CLI: pack then verify; usage errors exit non-zero", async (t) => {
  const bundle = await makeBundle(t);
  const out = join(await temp(t), "out");
  const pack = spawnSync(process.execPath, [script, "pack", bundle, out], {
    encoding: "utf8",
  });
  assert.equal(pack.status, 0, pack.stderr);
  const verify = spawnSync(
    process.execPath,
    [script, "verify", join(out, TARBALL)],
    { encoding: "utf8" },
  );
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(
    verify.stdout,
    /x86_64-unknown-linux-gnu, protocol 1, app 0.3.0-rc.9, 4 files/,
  );
  await writeFile(join(out, TARBALL), "not gzip");
  assert.notEqual(
    spawnSync(process.execPath, [script, "verify", join(out, TARBALL)]).status,
    0,
  );
  assert.notEqual(
    spawnSync(process.execPath, [script, "frobnicate"]).status,
    0,
  );
  assert.notEqual(
    spawnSync(process.execPath, [script, "pack", bundle]).status,
    0,
  );
});

// ---- macOS bundles: same determinism and strictness, a different file set (no apply-seccomp)
const DARWIN_FILES = {
  "srt-sidecar": { body: "#!sidecar\n" + "x".repeat(1500), exec: true },
  rg: { body: "mach-o rg", exec: true },
  "srt-proxy-agent.jar": { body: "PK\u0003\u0004jar", exec: false },
};

function darwinManifest(target, files = DARWIN_FILES, overrides = {}) {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    appVersion: "0.3.0-rc.9",
    target,
    srtVersion: "0.0.81",
    files: Object.fromEntries(
      Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, { body }]) => [
          name,
          { sha256: sha(body), size: Buffer.byteLength(body) },
        ]),
    ),
    ...overrides,
  };
}

async function makeDarwinBundle(t, target, files = DARWIN_FILES) {
  const dir = join(await temp(t), "bundle");
  await mkdir(dir);
  for (const [name, { body, exec }] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
    await chmod(join(dir, name), exec ? 0o755 : 0o644);
  }
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify(darwinManifest(target, files), null, 2) + "\n",
  );
  return dir;
}

for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
  test(`macOS bundle (${target}) packs and verifies with the darwin file set and no apply-seccomp`, async (t) => {
    const name = `sourceweft-sandbox-${target}.tar.gz`;
    const path = await packBundle(
      await makeDarwinBundle(t, target),
      join(await temp(t), "out"),
    );
    assert.equal(path.endsWith(name), true);
    const manifest = await verifyTarball(path);
    assert.equal(manifest.target, target);
    assert.deepEqual(Object.keys(manifest.files), [
      "rg",
      "srt-proxy-agent.jar",
      "srt-sidecar",
    ]);
    // Deterministic: a second pack of the same bundle is byte-identical.
    const again = await packBundle(
      await makeDarwinBundle(t, target),
      join(await temp(t), "out2"),
    );
    assert.deepEqual(await readFile(again), await readFile(path));
  });

  test(`macOS bundle (${target}) must not ship apply-seccomp`, async (t) => {
    const withSeccomp = {
      ...DARWIN_FILES,
      "apply-seccomp": { body: "seccomp", exec: true },
    };
    const bundle = await makeDarwinBundle(t, target, withSeccomp);
    await assert.rejects(
      packBundle(bundle, join(await temp(t), "o")),
      /bundle file set is not the darwin set/,
    );
  });
}

test("Linux bundle missing apply-seccomp is rejected on pack and on verify", async (t) => {
  const noSeccomp = {
    "srt-sidecar": FILES["srt-sidecar"],
    rg: FILES.rg,
    "srt-proxy-agent.jar": FILES["srt-proxy-agent.jar"],
  };
  // pack refuses it
  const bundle = await makeBundle(t, {
    files: noSeccomp,
    manifest: manifestFor(noSeccomp),
  });
  await assert.rejects(
    packBundle(bundle, join(await temp(t), "o")),
    /bundle file set is not the linux set/,
  );
  // and a hand-built archive missing apply-seccomp fails verify for the same reason
  await assert.rejects(
    verifyTarball(await writeArchive(t, goodEntries(noSeccomp))),
    /bundle file set is not the linux set/,
  );
});

// ---- Windows bundles: .exe names, srt-win.exe, no apply-seccomp, modes by extension
const WINDOWS_FILES = {
  "srt-sidecar.exe": { body: "MZ-sidecar" + "x".repeat(1500), exec: false },
  "rg.exe": { body: "MZ-rg", exec: false },
  "srt-win.exe": { body: "MZ-srt-win", exec: false },
  "srt-proxy-agent.jar": { body: "PK\u0003\u0004jar", exec: false },
};

async function makeWindowsBundle(t, target, files = WINDOWS_FILES) {
  const dir = join(await temp(t), "bundle");
  await mkdir(dir);
  for (const [name, { body, exec }] of Object.entries(files)) {
    await writeFile(join(dir, name), body);
    await chmod(join(dir, name), exec ? 0o755 : 0o644);
  }
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify(darwinManifest(target, files), null, 2) + "\n",
  );
  return dir;
}

function tarModes(tar) {
  const modes = {};
  for (let offset = 0; tar[offset] !== 0; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.toString("latin1", 0, header.indexOf(0));
    const octal = (from, len) =>
      Number.parseInt(
        header.toString("latin1", from, from + len).replace(/\0.*/, ""),
        8,
      );
    modes[name] = octal(100, 8);
    offset += 512 + Math.ceil(octal(124, 12) / 512) * 512;
  }
  return modes;
}

for (const target of ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"]) {
  test(`Windows bundle (${target}) packs and verifies with the windows file set`, async (t) => {
    const path = await packBundle(
      await makeWindowsBundle(t, target),
      join(await temp(t), "out"),
    );
    assert.equal(path.endsWith(`sourceweft-sandbox-${target}.tar.gz`), true);
    const manifest = await verifyTarball(path);
    assert.equal(manifest.target, target);
    assert.deepEqual(Object.keys(manifest.files), [
      "rg.exe",
      "srt-proxy-agent.jar",
      "srt-sidecar.exe",
      "srt-win.exe",
    ]);
    const again = await packBundle(
      await makeWindowsBundle(t, target),
      join(await temp(t), "out2"),
    );
    assert.deepEqual(await readFile(again), await readFile(path));
  });

  test(`Windows bundle (${target}) gets tar modes from the extension, not from the file system`, async (t) => {
    // Files built on Windows carry no exec bit; one that did (a bundle assembled elsewhere) must
    // not leak it onto the jar. .exe -> 0755, everything else 0644.
    const files = {
      ...WINDOWS_FILES,
      "srt-proxy-agent.jar": { body: "PK\u0003\u0004jar", exec: true },
      "rg.exe": { body: "MZ-rg", exec: false },
    };
    const path = await packBundle(
      await makeWindowsBundle(t, target, files),
      join(await temp(t), "out"),
    );
    const { gunzipSync } = await import("node:zlib");
    assert.deepEqual(tarModes(gunzipSync(await readFile(path))), {
      "manifest.json": 0o644,
      "rg.exe": 0o755,
      "srt-proxy-agent.jar": 0o644,
      "srt-sidecar.exe": 0o755,
      "srt-win.exe": 0o755,
    });
  });

  test(`Windows bundle (${target}) rejects apply-seccomp, extension-less names and a missing srt-win.exe`, async (t) => {
    const reject = async (files, pattern) =>
      assert.rejects(
        packBundle(
          await makeWindowsBundle(t, target, files),
          join(await temp(t), "o"),
        ),
        pattern,
      );
    await reject(
      { ...WINDOWS_FILES, "apply-seccomp": { body: "seccomp", exec: true } },
      /bundle file set is not the windows set/,
    );
    const { "srt-win.exe": _runner, ...noRunner } = WINDOWS_FILES;
    await reject(noRunner, /bundle file set is not the windows set/);
    const { "rg.exe": _rg, ...noRg } = WINDOWS_FILES;
    await reject(
      { ...noRg, rg: { body: "MZ-rg", exec: true } },
      /bundle file set is not the windows set/,
    );
    // A Linux-shaped file set under a Windows target is the same mistake.
    await reject(FILES, /bundle file set is not the windows set/);
  });
}

test("a Windows file set under a Linux or macOS target is rejected too", async (t) => {
  for (const target of [TARGET, "aarch64-apple-darwin"]) {
    const dir = await makeWindowsBundle(t, target);
    await assert.rejects(
      packBundle(dir, join(await temp(t), "o")),
      /bundle file set is not the (linux|darwin) set/,
    );
  }
});

test("verify rejects a Windows .exe that is not 0755 and a non-.exe that is", async (t) => {
  const target = "x86_64-pc-windows-msvc";
  const name = `sourceweft-sandbox-${target}.tar.gz`;
  const entries = (modes) => {
    const manifest = darwinManifest(target, WINDOWS_FILES);
    return [
      {
        name: "manifest.json",
        body: JSON.stringify(manifest, null, 2) + "\n",
      },
      ...Object.entries(WINDOWS_FILES)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([file, { body }]) => ({
          name: file,
          body,
          mode: modes[file] ?? (file.endsWith(".exe") ? 0o755 : 0o644),
        })),
    ];
  };
  await verifyTarball(await writeArchive(t, entries({}), name));
  await assert.rejects(
    verifyTarball(
      await writeArchive(t, entries({ "rg.exe": 0o644 }), name),
    ),
    /must be 755: rg\.exe/,
  );
  await assert.rejects(
    verifyTarball(
      await writeArchive(t, entries({ "srt-proxy-agent.jar": 0o755 }), name),
    ),
    /must be 644: srt-proxy-agent\.jar/,
  );
});

test("the tar writer rejects names over the 100-byte ustar limit instead of corrupting the header", () => {
  const entry = (name) => [{ name, bytes: Buffer.from("x"), mode: 0o644 }];
  assert.doesNotThrow(() => writeTar(entry("a".repeat(100))));
  assert.throws(() => writeTar(entry("a".repeat(101))), /100-byte ustar limit/);
});
