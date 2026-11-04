#!/usr/bin/env bun
/**
 * Builds the sidecar bundle: `dist/bundle/{srt-sidecar, rg, apply-seccomp, srt-proxy-agent.jar}`
 * (Linux), `{srt-sidecar, rg, srt-proxy-agent.jar}` (macOS) or
 * `{srt-sidecar.exe, rg.exe, srt-win.exe, srt-proxy-agent.jar}` (Windows). Which files, what
 * they are called and where they are copied from is decided by `bundlePlan` in `manifest.ts`
 * (pure and unit-tested; this script only does the I/O).
 *
 * `srt-sidecar` is `src/main.ts` compiled by Bun into a single executable; `rg` is copied from
 * the path given via `--rg <path>` (CI passes the pinned ripgrep — this script never bundles
 * ripgrep itself); `apply-seccomp` is copied from the installed srt package's
 * `vendor/seccomp/<x64|arm64>/apply-seccomp` and is Linux-only (the daemon only needs it on
 * Linux, and there is no macOS build of it to copy); `srt-win.exe` is copied from
 * `vendor/srt-win/<x64|arm64>/srt-win.exe` (Windows only; the architecture is the target's);
 * `srt-proxy-agent.jar` is copied from `vendor/java-proxy-agent/srt-proxy-agent.jar`. On Windows
 * the copied `srt-win.exe` must equal the SHA-256 pinned in `srt-win-pin.json` (the build fails
 * otherwise): the desktop app runs a staged copy of it as administrator only if it has that hash,
 * which is also why it is never Authenticode-signed.
 *
 * Finally it writes `manifest.json` (the wire contract the Rust installer and
 * `scripts/ci/sandbox-bundle.mjs` verify): schema version, `SANDBOX_PROTOCOL_VERSION`, the
 * desktop app version, the Rust target triple, the installed srt package version and the
 * sha256 + size of every other file. The output directory is emptied first so the manifest
 * describes exactly this build.
 *
 * Run as `bun run build -- --rg <path> [--target <rust triple>]` (or
 * `bun run scripts/build.ts ...` directly) from this package's directory. `--target` is
 * optional only on Linux x64; elsewhere it is required (no guessing) and must be a triple for
 * the build host's OS (a same-OS cross-architecture build, e.g. macOS x86_64 on the arm64
 * runner, is compiled with an explicit Bun `--target`).
 *
 * `--remanifest` rewrites `manifest.json` over the files already in `dist/bundle` (preserving
 * the protocol/app/srt versions and target from the existing manifest) WITHOUT recompiling or
 * recopying anything. The macOS release legs run it after `scripts/sign-macos.sh` has code-signed
 * the binaries in place: code-signing changes the binaries' bytes, so the build-time manifest no
 * longer matches them and `sandbox-bundle.mjs pack` would reject the stale hashes. The Linux legs
 * never code-sign the bundle, so they never run this and their behaviour is unchanged.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_PROTOCOL_VERSION } from "../src/protocol.js";
import {
  MANIFEST_FILENAME,
  assertBunVersion,
  assertSrtWinMatchesPin,
  buildManifest,
  bundlePlan,
  bunCompileArgs,
  bunCompileTarget,
  readSrtWinPin,
  resolveTarget,
} from "./manifest.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(packageRoot, "dist", "bundle");

const USAGE =
  "usage: bun run scripts/build.ts --rg <path-to-ripgrep> [--target <rust triple>]";

function optionValue(
  argv: readonly string[],
  flag: string,
): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${flag} needs a value; ${USAGE}`);
  return value;
}

function parseRgPath(argv: readonly string[]): string {
  const value = optionValue(argv, "--rg");
  if (value === undefined) throw new Error(USAGE);
  return value;
}

function readVersion(packageJsonPath: string, what: string): string {
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string" || version === "") {
    throw new Error(`${what} has no version in ${packageJsonPath}`);
  }
  return version;
}

function requireFile(path: string, what: string): void {
  if (!existsSync(path)) {
    throw new Error(`${what} not found at ${path}`);
  }
}

function copyFile(source: string, destName: string, execBit: boolean): void {
  const dest = join(outDir, destName);
  copyFileSync(source, dest);
  // Windows has no exec bit; `sandbox-bundle.mjs pack` assigns tar modes by extension there.
  if (execBit) chmodSync(dest, 0o755);
}

/**
 * A Windows bundle's `srt-win.exe` must be byte for byte the file pinned in `srt-win-pin.json`:
 * the desktop app's elevated setup stages and runs only a file with that SHA-256 (the manifest is
 * in user-writable app data and authorises nothing). Called after the files are copied and again
 * before a re-manifest, which is what catches an `srt-win.exe` that was Authenticode-signed.
 */
function assertWindowsSrtWinPinned(target: string): void {
  if (!target.endsWith("-pc-windows-msvc")) return;
  const sha256 = createHash("sha256")
    .update(readFileSync(join(outDir, "srt-win.exe")))
    .digest("hex");
  assertSrtWinMatchesPin(target, sha256, readSrtWinPin());
}

/**
 * Rewrites `manifest.json` over the current contents of `dist/bundle`, keeping the version and
 * target fields from the existing manifest. Used after the macOS bundle is code-signed in place.
 */
function remanifest(): void {
  const manifestPath = join(outDir, MANIFEST_FILENAME);
  requireFile(manifestPath, "manifest.json (run the build before --remanifest)");
  const previous: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const p = previous as {
    protocolVersion?: unknown;
    appVersion?: unknown;
    target?: unknown;
    srtVersion?: unknown;
  };
  if (
    typeof p.protocolVersion !== "number" ||
    typeof p.appVersion !== "string" ||
    typeof p.target !== "string" ||
    typeof p.srtVersion !== "string"
  ) {
    throw new Error(`existing manifest is missing fields: ${manifestPath}`);
  }
  assertWindowsSrtWinPinned(p.target);
  const manifest = buildManifest({
    bundleDir: outDir,
    protocolVersion: p.protocolVersion,
    appVersion: p.appVersion,
    target: p.target,
    srtVersion: p.srtVersion,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`re-manifested ${outDir} (${manifest.target}) over signed files`);
}

function main(): void {
  assertBunVersion(process.versions.bun);
  if (process.argv.slice(2).includes("--remanifest")) {
    remanifest();
    return;
  }
  const rgPath = parseRgPath(process.argv.slice(2));
  requireFile(rgPath, "ripgrep binary (--rg)");
  const target = resolveTarget(
    optionValue(process.argv.slice(2), "--target"),
    process.platform,
    process.arch,
  );

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const plan = bundlePlan(target);
  copyFile(rgPath, plan.rgName, plan.setExecBit);
  for (const { from, to, executable } of plan.vendorCopies) {
    const source = join(packageRoot, ...from.split("/"));
    requireFile(source, to);
    copyFile(source, to, executable);
  }
  assertWindowsSrtWinPinned(target);

  // A native build compiles with no `--target` (byte-identical to the historical Linux build);
  // a same-OS cross build (macOS x86_64 on the arm64 runner) passes the explicit Bun target so
  // Bun fetches and uses that runtime instead of the host's.
  //
  // Compile with `process.execPath` — the very Bun that runs this script (its version already
  // pinned by `assertBunVersion`) — not a bare `"bun"` from PATH. Resolving `bun` through PATH
  // could pick a different, untested Bun (e.g. an older one earlier on PATH) and silently emit a
  // bundle whose sidecar never replies to `init` (the E2E trap).
  const crossTarget = bunCompileTarget(target, process.platform, process.arch);
  const compile = spawnSync(
    process.execPath,
    bunCompileArgs({
      entry: join(packageRoot, "src/main.ts"),
      outFile: join(outDir, plan.sidecarName),
      crossTarget,
    }),
    { stdio: "inherit", cwd: packageRoot },
  );
  if (compile.status !== 0) {
    throw new Error(
      `bun build --compile exited with status ${String(compile.status)}`,
    );
  }

  const srtPackage = join(
    packageRoot,
    "node_modules/@anthropic-ai/sandbox-runtime/package.json",
  );
  const manifest = buildManifest({
    bundleDir: outDir,
    protocolVersion: SANDBOX_PROTOCOL_VERSION,
    appVersion: readVersion(
      join(packageRoot, "..", "package.json"),
      "the desktop app",
    ),
    target,
    srtVersion: readVersion(srtPackage, "@anthropic-ai/sandbox-runtime"),
  });
  writeFileSync(
    join(outDir, MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  console.log(`sidecar bundle (${target}) written to ${outDir}`);
}

main();
