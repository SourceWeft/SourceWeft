// Packs, signs and verifies the local-execution sandbox bundle release asset.
//
//   node scripts/ci/sandbox-bundle.mjs pack <bundleDir> <outDir>
//   node scripts/ci/sandbox-bundle.mjs verify <tarball>
//   node scripts/ci/sandbox-bundle.mjs sign <tarball>
//   node scripts/ci/sandbox-bundle.mjs verify-signature <tarball>
//
// The archive is what the desktop app downloads from the GitHub Release and verifies
// (minisign over the whole file, then manifest + per-file hashes) before extracting. Layout:
// a deterministic ustar stream, gzip level 9, whose entries are only plain files at the archive
// root (no directory, link, device, pax or GNU long-name entries) with `manifest.json` first.
// Node built-ins only, like the other scripts/ci tooling; ustar is small enough to implement here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

export const MANIFEST_FILENAME = "manifest.json";
export const MAX_FILE_SIZE = 256 * 1024 * 1024;
export const MAX_ARCHIVE_SIZE = 256 * 1024 * 1024;

const BLOCK = 512;
// Entry names are single path components made of these characters only: this alone rules out
// absolute paths, "..", "." and nested paths.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const TARGET = /^[a-z0-9_]+(-[a-z0-9_]+){2,3}$/;
const MANIFEST_KEYS = [
  "appVersion",
  "files",
  "protocolVersion",
  "schemaVersion",
  "srtVersion",
  "target",
];

export function tarballName(target) {
  return `sourceweft-sandbox-${target}.tar.gz`;
}

// The files `build.ts` lays down, by platform (build.ts's `bundlePlan` is the producer of these
// names). Every platform carries the compiled sidecar, the ripgrep binary srt runs and the Java
// proxy agent. Linux additionally carries srt's `apply-seccomp` helper, which has no macOS or
// Windows build and which neither needs (Seatbelt; the Windows sandbox account). Windows
// additionally carries `srt-win.exe` (the broker and the sandbox-account runner) and names its
// executables `*.exe`. The set is validated against the manifest target on pack and verify so a
// Linux bundle can never ship without apply-seccomp, a macOS or Windows bundle can never ship
// one, and a Windows bundle can never ship without srt-win.exe.
const FILE_SETS = {
  linux: ["apply-seccomp", "rg", "srt-proxy-agent.jar", "srt-sidecar"],
  darwin: ["rg", "srt-proxy-agent.jar", "srt-sidecar"],
  windows: ["rg.exe", "srt-proxy-agent.jar", "srt-sidecar.exe", "srt-win.exe"],
};

/** Maps a Rust target triple to the sandbox platform, or throws for an unsupported one. */
export function platformOfTarget(target) {
  if (target.endsWith("-apple-darwin")) return "darwin";
  if (target.includes("-linux-")) return "linux";
  if (target.endsWith("-pc-windows-msvc")) return "windows";
  assert.fail(`unsupported bundle target platform: ${target}`);
}

/** The bundle's file names (manifest.json excluded) must be exactly the set for its platform. */
export function validateFileSet(target, names) {
  const platform = platformOfTarget(target);
  const expected = [...FILE_SETS[platform]].sort();
  const actual = [...names].sort();
  assert.deepEqual(
    actual,
    expected,
    `bundle file set is not the ${platform} set for ${target} (expected: ${expected.join(", ")}; actual: ${actual.join(", ")})`,
  );
}

/**
 * The tar mode of a bundle file. Linux and macOS read it off the exec bit the build left on the
 * file. Windows has no exec bit (a bundle built there reports none), so the mode comes from the
 * name alone: `*.exe` is 0755, anything else 0644. The installer's extraction accepts exactly
 * these two modes.
 */
function modeFor(platform, name, fileMode) {
  if (platform === "windows") return name.endsWith(".exe") ? 0o755 : 0o644;
  return fileMode & 0o111 ? 0o755 : 0o644;
}

// ---------------------------------------------------------------- manifest

/** Validates the manifest shape; returns it unchanged. Throws with an exact reason. */
export function validateManifest(manifest) {
  assert(
    manifest && typeof manifest === "object" && !Array.isArray(manifest),
    "manifest must be an object",
  );
  assert.deepEqual(
    Object.keys(manifest).sort(),
    MANIFEST_KEYS,
    "manifest has missing or unexpected keys",
  );
  assert.equal(manifest.schemaVersion, 1, "unsupported manifest schemaVersion");
  assert(
    Number.isInteger(manifest.protocolVersion) && manifest.protocolVersion >= 1,
    "manifest protocolVersion must be a positive integer",
  );
  assert(
    typeof manifest.appVersion === "string" && SEMVER.test(manifest.appVersion),
    "manifest appVersion is not a version",
  );
  assert(
    typeof manifest.srtVersion === "string" && SEMVER.test(manifest.srtVersion),
    "manifest srtVersion is not a version",
  );
  assert(
    typeof manifest.target === "string" && TARGET.test(manifest.target),
    "manifest target is not a Rust target triple",
  );
  const files = manifest.files;
  assert(
    files && typeof files === "object" && !Array.isArray(files),
    "manifest files must be an object",
  );
  const names = Object.keys(files);
  assert(names.length > 0, "manifest lists no files");
  for (const name of names) {
    assert(NAME.test(name), `manifest file name is not allowed: ${name}`);
    assert.notEqual(name, MANIFEST_FILENAME, "manifest must not list itself");
    const entry = files[name];
    assert(
      entry && typeof entry === "object" && !Array.isArray(entry),
      `manifest entry is not an object: ${name}`,
    );
    assert.deepEqual(Object.keys(entry).sort(), ["sha256", "size"], name);
    assert(
      typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/.test(entry.sha256),
      `manifest sha256 is not lowercase hex: ${name}`,
    );
    assert(
      Number.isSafeInteger(entry.size) &&
        entry.size >= 0 &&
        entry.size <= MAX_FILE_SIZE,
      `manifest size is out of range: ${name}`,
    );
  }
  return manifest;
}

function parseManifest(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    assert.fail("manifest.json is not valid JSON");
  }
  return validateManifest(value);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Every entry must be exactly what the manifest says: same names, sizes and hashes. */
function checkAgainstManifest(manifest, files) {
  const listed = Object.keys(manifest.files).sort();
  const actual = [...files.keys()].sort();
  assert.deepEqual(
    actual,
    listed,
    `file set differs from the manifest (manifest: ${listed.join(", ")}; actual: ${actual.join(", ")})`,
  );
  for (const [name, bytes] of files) {
    const expected = manifest.files[name];
    assert.equal(bytes.length, expected.size, `size mismatch: ${name}`);
    assert.equal(sha256(bytes), expected.sha256, `sha256 mismatch: ${name}`);
  }
}

// -------------------------------------------------------------------- ustar

const octal = (value, width) => {
  const text = value.toString(8).padStart(width - 1, "0");
  assert(text.length === width - 1, "value does not fit a tar header field");
  return `${text}\0`;
};

function header({ name, size, mode }) {
  // The ustar name field is 100 bytes; a longer name would overwrite the mode field.
  assert(
    Buffer.byteLength(name, "latin1") <= 100,
    `entry name is longer than the 100-byte ustar limit: ${name}`,
  );
  const block = Buffer.alloc(BLOCK);
  const put = (offset, text) => block.write(text, offset, "latin1");
  put(0, name);
  put(100, octal(mode, 8));
  put(108, octal(0, 8)); // uid
  put(116, octal(0, 8)); // gid
  put(124, octal(size, 12));
  put(136, octal(0, 12)); // mtime
  put(148, "        "); // checksum placeholder: eight spaces
  put(156, "0"); // regular file
  put(257, "ustar\0");
  put(263, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

/** entries: [{ name, bytes, mode }] in the order to write. */
export function writeTar(entries) {
  const parts = [];
  for (const { name, bytes, mode } of entries) {
    assert(NAME.test(name), `entry name is not allowed: ${name}`);
    parts.push(header({ name, size: bytes.length, mode }), bytes);
    const pad = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

const field = (block, offset, length) => {
  const end = block.indexOf(0, offset);
  const stop = end === -1 || end > offset + length ? offset + length : end;
  return block.toString("latin1", offset, stop);
};

function parseOctal(block, offset, length, what) {
  const text = field(block, offset, length).trim();
  assert(/^[0-7]+$/.test(text), `tar header has an invalid ${what} field`);
  return Number.parseInt(text, 8);
}

/**
 * Parses a tar stream strictly. Only regular files with safe single-component names are
 * accepted; anything else (directories, links, devices, pax/GNU extensions, absolute or nested
 * names, duplicates, trailing data) throws. Returns [{ name, bytes, mode }] in archive order.
 */
export function readTar(tar) {
  const entries = [];
  const seen = new Set();
  let offset = 0;
  for (;;) {
    assert(offset + BLOCK <= tar.length, "tar archive is truncated");
    const block = tar.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (block.every((byte) => byte === 0)) {
      assert(
        offset + BLOCK <= tar.length &&
          tar.subarray(offset).every((byte) => byte === 0),
        "tar archive has a bad end marker or trailing data",
      );
      return entries;
    }
    const stored = parseOctal(block, 148, 8, "checksum");
    const copy = Buffer.from(block);
    copy.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of copy) sum += byte;
    assert.equal(sum, stored, "tar header checksum mismatch");
    const type = String.fromCharCode(block[156]);
    assert(
      type === "0" || type === "\0",
      `unexpected tar entry type ${JSON.stringify(type)} (only plain files are allowed)`,
    );
    assert.equal(field(block, 257, 6), "ustar", "not a ustar header");
    const name = field(block, 0, 100);
    assert.equal(
      field(block, 345, 155),
      "",
      `entry has a path prefix: ${name}`,
    );
    assert.equal(
      field(block, 157, 100),
      "",
      `entry has a link target: ${name}`,
    );
    assert(NAME.test(name), `unsafe entry name: ${JSON.stringify(name)}`);
    assert(!seen.has(name), `duplicate entry: ${name}`);
    seen.add(name);
    const mode = parseOctal(block, 100, 8, "mode") & 0o7777;
    assert(
      mode === 0o755 || mode === 0o644,
      `unexpected mode ${mode.toString(8)}: ${name}`,
    );
    const size = parseOctal(block, 124, 12, "size");
    assert(size <= MAX_FILE_SIZE, `entry too large: ${name}`);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    assert(offset + padded <= tar.length, `tar entry is truncated: ${name}`);
    const bytes = Buffer.from(tar.subarray(offset, offset + size));
    assert(
      tar.subarray(offset + size, offset + padded).every((byte) => byte === 0),
      `tar padding is not zero: ${name}`,
    );
    offset += padded;
    entries.push({ name, bytes, mode });
  }
}

// -------------------------------------------------------------------- gzip

function gzip(tar) {
  const out = gzipSync(tar, { level: 9 });
  // Header: mtime (bytes 4..8) is already zero; pin the OS byte so every platform agrees.
  out[9] = 3;
  return out;
}

function gunzip(bytes) {
  assert(bytes.length <= MAX_ARCHIVE_SIZE, "archive exceeds the size limit");
  return gunzipSync(bytes, { maxOutputLength: MAX_ARCHIVE_SIZE + 64 * BLOCK });
}

// -------------------------------------------------------------- pack/verify

/** Reads <bundleDir> (which must already match its manifest) and writes the tarball. */
export async function packBundle(bundleDir, outDir) {
  const manifestBytes = await readFile(join(bundleDir, MANIFEST_FILENAME));
  const manifest = parseManifest(manifestBytes);
  const platform = platformOfTarget(manifest.target);
  const files = new Map();
  const modes = new Map();
  for (const entry of await readdir(bundleDir, { withFileTypes: true })) {
    assert(entry.isFile(), `bundle entry is not a regular file: ${entry.name}`);
    if (entry.name === MANIFEST_FILENAME) continue;
    const path = join(bundleDir, entry.name);
    const { mode } = await lstat(path);
    files.set(entry.name, await readFile(path));
    modes.set(entry.name, modeFor(platform, entry.name, mode));
  }
  checkAgainstManifest(manifest, files);
  validateFileSet(manifest.target, files.keys());
  const entries = [
    { name: MANIFEST_FILENAME, bytes: manifestBytes, mode: 0o644 },
  ];
  for (const name of [...files.keys()].sort()) {
    entries.push({ name, bytes: files.get(name), mode: modes.get(name) });
  }
  await mkdir(outDir, { recursive: true });
  const output = join(outDir, tarballName(manifest.target));
  await writeFile(output, gzip(writeTar(entries)));
  return output;
}

/** Re-reads the tarball and checks it end to end. Returns the manifest. */
export async function verifyTarball(path) {
  const entries = readTar(gunzip(await readFile(path)));
  assert(entries.length > 0, "archive is empty");
  assert.equal(
    entries[0].name,
    MANIFEST_FILENAME,
    "manifest.json must be the first entry",
  );
  assert.equal(entries[0].mode, 0o644, "manifest.json must not be executable");
  const manifest = parseManifest(entries[0].bytes);
  assert.equal(
    basename(path),
    tarballName(manifest.target),
    "file name does not match the manifest target",
  );
  checkAgainstManifest(
    manifest,
    new Map(entries.slice(1).map(({ name, bytes }) => [name, bytes])),
  );
  validateFileSet(
    manifest.target,
    entries.slice(1).map(({ name }) => name),
  );
  if (platformOfTarget(manifest.target) === "windows") {
    for (const { name, mode } of entries.slice(1)) {
      const expected = modeFor("windows", name, 0);
      assert.equal(
        mode,
        expected,
        `windows bundle mode must be ${expected.toString(8)}: ${name}`,
      );
    }
  }
  return manifest;
}

// ------------------------------------------------------------------ signing

function run(command, args, env) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} failed with status ${result.status}`,
  );
}

/** Minisign signature by the Tauri updater key, written to <tarball>.sig. */
export function signTarball(path) {
  assert(
    process.env.TAURI_SIGNING_PRIVATE_KEY ||
      process.env.TAURI_SIGNING_PRIVATE_KEY_PATH,
    "TAURI_SIGNING_PRIVATE_KEY is required to sign the sandbox bundle",
  );
  const absolute = resolve(path);
  run("pnpm", [
    "--filter",
    "@sourceweft/desktop",
    "exec",
    "tauri",
    "signer",
    "sign",
    // pnpm runs the CLI from apps/desktop, so a relative path would point at the wrong file.
    absolute,
  ]);
  return `${absolute}.sig`;
}

/** Verifies <tarball>.sig with the same minisign-verify tool used for updater packages. */
export function verifySignature(path) {
  const verifier = process.env.DESKTOP_UPDATE_VERIFIER;
  assert(verifier, "DESKTOP_UPDATE_VERIFIER is required");
  assert(
    process.env.TAURI_UPDATER_PUBLIC_KEY,
    "TAURI_UPDATER_PUBLIC_KEY is required",
  );
  run(verifier, [path, `${path}.sig`]);
}

// ---------------------------------------------------------------------- CLI

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, ...args] = process.argv.slice(2);
  const usage =
    "usage: sandbox-bundle.mjs pack <bundleDir> <outDir> | verify|sign|verify-signature <tarball>";
  if (command === "pack" && args.length === 2) {
    const output = await packBundle(args[0], args[1]);
    console.log(`packed ${output}`);
  } else if (command === "verify" && args.length === 1) {
    const manifest = await verifyTarball(args[0]);
    console.log(
      `verified ${args[0]}: ${manifest.target}, protocol ${manifest.protocolVersion}, app ${manifest.appVersion}, ${Object.keys(manifest.files).length} files`,
    );
  } else if (command === "sign" && args.length === 1) {
    console.log(`signed ${signTarball(args[0])}`);
  } else if (command === "verify-signature" && args.length === 1) {
    verifySignature(args[0]);
    console.log(`signature verified for ${args[0]}`);
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
}
