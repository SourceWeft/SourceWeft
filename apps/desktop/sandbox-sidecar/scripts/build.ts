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
 * Run as `bun run build -- --rg <path>` (or `bun run scripts/build.ts --rg <path>` directly)
 * from this package's directory.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(packageRoot, "dist", "bundle");

function parseRgPath(argv: readonly string[]): string {
  const index = argv.indexOf("--rg");
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined) {
    throw new Error("usage: bun run scripts/build.ts --rg <path-to-ripgrep>");
  }
  return value;
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
  throw new Error(`no vendored apply-seccomp for architecture ${arch} (expected x64 or arm64)`);
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

function main(): void {
  requireBunVersion();
  const rgPath = parseRgPath(process.argv.slice(2));
  requireFile(rgPath, "ripgrep binary (--rg)");

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
    console.log(`skipping apply-seccomp: not Linux (platform is ${process.platform})`);
  }

  const jarSource = join(
    packageRoot,
    "node_modules/@anthropic-ai/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar",
  );
  requireFile(jarSource, "srt-proxy-agent.jar");
  copyFileSync(jarSource, join(outDir, "srt-proxy-agent.jar"));

  const compile = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      "--define",
      '__SRT_WIN_NAMESPACE__="sourceweft"',
      join(packageRoot, "src/main.ts"),
      "--outfile",
      join(outDir, "srt-sidecar"),
    ],
    { stdio: "inherit", cwd: packageRoot },
  );
  if (compile.status !== 0) {
    throw new Error(`bun build --compile exited with status ${String(compile.status)}`);
  }

  console.log(`sidecar bundle written to ${outDir}`);
}

main();
