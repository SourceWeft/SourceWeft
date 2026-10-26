#!/usr/bin/env bun
/**
 * Builds the sidecar bundle: `dist/bundle/{srt-sidecar, rg, apply-seccomp, srt-proxy-agent.jar}`.
 *
 * `srt-sidecar` is `src/main.ts` compiled by Bun into a single executable; `rg` is copied from
 * the path given via `--rg <path>` (CI passes `$(command -v rg)` — this script never bundles
 * ripgrep itself); `apply-seccomp` is copied from the installed srt package's
 * `vendor/seccomp/<x64|arm64>/apply-seccomp`, matching the build machine's architecture, and is
 * Linux-only (skipped on macOS — the daemon only needs it on Linux, and there is no macOS
 * build of it to copy); `srt-proxy-agent.jar` is copied from
 * `vendor/java-proxy-agent/srt-proxy-agent.jar`.
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
  buildManifest,
  bunCompileTarget,
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

/**
 * The Bun release the bundle is built and tested with (CI pins the same one). Older Bun
 * releases break srt's proxy (the design's Global Constraints), so any other version is refused
 * rather than producing a bundle nobody tested (final review M4).
 */
const REQUIRED_BUN_VERSION = "1.4.2";

function requireBunVersion(): void {
  const version = process.versions.bun;
  if (version !== REQUIRED_BUN_VERSION) {
    throw new Error(
      `the sidecar bundle must be built with Bun ${REQUIRED_BUN_VERSION}, got ${version ?? "no Bun (run with bun)"}`,
    );
  }
}

/** srt's vendored `apply-seccomp` directory for this machine's architecture; no guessing. */
function seccompArch(arch: string): "x64" | "arm64" {
  if (arch === "x64" || arch === "arm64") return arch;
  throw new Error(
    `no vendored apply-seccomp for architecture ${arch} (expected x64 or arm64)`,
  );
}

function requireFile(path: string, what: string): void {
  if (!existsSync(path)) {
    throw new Error(`${what} not found at ${path}`);
  }
}

function copyExecutable(source: string, destName: string): void {
  const dest = join(outDir, destName);
  copyFileSync(source, dest);
  chmodSync(dest, 0o755);
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
  requireBunVersion();
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

  copyExecutable(rgPath, "rg");

  if (process.platform === "linux") {
    const arch = seccompArch(process.arch);
    const seccompSource = join(
      packageRoot,
      "node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp",
      arch,
      "apply-seccomp",
    );
    requireFile(seccompSource, `apply-seccomp (${arch})`);
    copyExecutable(seccompSource, "apply-seccomp");
  } else {
    console.log(
      `skipping apply-seccomp: not Linux (platform is ${process.platform})`,
    );
  }

  const jarSource = join(
    packageRoot,
    "node_modules/@anthropic-ai/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar",
  );
  requireFile(jarSource, "srt-proxy-agent.jar");
  copyFileSync(jarSource, join(outDir, "srt-proxy-agent.jar"));

  // A native build compiles with no `--target` (byte-identical to the historical Linux build);
  // a same-OS cross build (macOS x86_64 on the arm64 runner) passes the explicit Bun target so
  // Bun fetches and uses that runtime instead of the host's.
  const crossTarget = bunCompileTarget(target, process.platform, process.arch);
  const compile = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      ...(crossTarget ? [`--target=${crossTarget}`] : []),
      "--define",
      '__SRT_WIN_NAMESPACE__="sourceweft"',
      join(packageRoot, "src/main.ts"),
      "--outfile",
      join(outDir, "srt-sidecar"),
    ],
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
