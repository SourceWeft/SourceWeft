"use strict";
const { spawnSync } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} = require("node:fs");
const { join, resolve } = require("node:path");
const { createHash } = require("node:crypto");
const root = resolve(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "UPSTREAM.json"), "utf8"));
for (const file of manifest.files) {
  const actual = createHash("sha256")
    .update(readFileSync(join(root, "upstream", file.path)))
    .digest("hex");
  if (actual !== (file.patchedSha256 || file.sha256))
    throw new Error(`Pinned AnyDoc source checksum mismatch: ${file.path}`);
}
for (const file of manifest.wrapperFiles) {
  const actual = createHash("sha256")
    .update(readFileSync(join(root, file.path)))
    .digest("hex");
  if (actual !== file.sha256)
    throw new Error(`Pinned AnyDoc wrapper checksum mismatch: ${file.path}`);
}
const licenseHash = createHash("sha256")
  .update(readFileSync(join(root, "THIRD_PARTY_NOTICES.txt")))
  .digest("hex");
if (licenseHash !== manifest.licenseNoticesSha256)
  throw new Error("Native license notices checksum mismatch");
const rustc = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
if (rustc.error) throw rustc.error;
if (rustc.status !== 0)
  throw new Error("Unable to inspect the native Rust toolchain");
const host = /^host: (.+)$/m.exec(rustc.stdout)?.[1];
if (!host) throw new Error("Rust toolchain did not declare its host target");
const target = process.env.CARGO_BUILD_TARGET;
const effectiveTarget = target || host;
const supportedTargets = new Set([
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
]);
if (!supportedTargets.has(effectiveTarget))
  throw new Error(
    `Unsupported maintained AnyDoc native target: ${effectiveTarget}`,
  );
// Node loads a shared library: musl's default static CRT disallows this cdylib.
const musl = effectiveTarget.endsWith("-musl");
const rustflags = musl
  ? `${process.env.RUSTFLAGS || ""} -C target-feature=-crt-static`.trim()
  : process.env.RUSTFLAGS;

const args = [
  "build",
  "--locked",
  "--release",
  "--manifest-path",
  join(root, "upstream/node/Cargo.toml"),
];
if (target) args.push("--target", target);
const result = spawnSync("cargo", args, {
  stdio: "inherit",
  env: { ...process.env, ...(rustflags ? { RUSTFLAGS: rustflags } : {}) },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const directory = resolve(
  process.env.CARGO_TARGET_DIR || join(root, "upstream/target"),
  ...(target ? [target] : []),
  "release",
);
const filename = effectiveTarget.includes("apple-darwin")
  ? "libanydoc_node.dylib"
  : effectiveTarget.includes("windows")
    ? "anydoc_node.dll"
    : "libanydoc_node.so";
const binary = join(directory, filename);
if (!existsSync(binary))
  throw new Error("Native build did not produce the expected binding");
mkdirSync(join(root, "native"), { recursive: true });
copyFileSync(binary, join(root, "native/bindings.node"));
const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
writeFileSync(
  join(root, "native/build.json"),
  JSON.stringify(
    {
      upstreamVersion: "0.2.4",
      upstreamCommit: "42bf1c5ecdde9eb0d96d6bd75a9e6698cf93b14c",
      pdfInspectorVersion: "1.14.2",
      licenseNoticesSha256: licenseHash,
      platform: effectiveTarget.includes("apple-darwin")
        ? "darwin"
        : effectiveTarget.includes("windows")
          ? "win32"
          : "linux",
      architecture: effectiveTarget.startsWith("aarch64") ? "arm64" : "x64",
      target: effectiveTarget,
      muslDynamicCrt: musl,
      rustcVersion: rustc.stdout.split("\n")[0],
      sha256,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Maintained AnyDoc native binding built: ${sha256}`);
