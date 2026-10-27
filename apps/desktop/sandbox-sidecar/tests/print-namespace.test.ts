import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bunCompileArgs } from "../scripts/manifest.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(packageRoot, "src/main.ts");

/** The one line `--print-namespace` writes: the last path segment of srt's Windows state dir. */
function printedNamespace(command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: packageRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, `expected exactly one line, got ${JSON.stringify(result.stdout)}`);
  return lines[0] as string;
}

const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
const hasBun = bun.status === 0;

/**
 * Bundles `src/main.ts` for Node with the very `--define` arguments `build.ts` passes to
 * `bun build --compile` (minus the compile-only flags), optionally mangled by `mangle`, and
 * returns the path of the bundle. A bundle (not a compiled executable) runs on any host.
 */
function bundleWithDefine(dir: string, mangle: (arg: string) => string): string {
  const outFile = join(dir, "main.js");
  const args = bunCompileArgs({ entry, outFile, crossTarget: undefined })
    .filter((arg) => arg !== "--compile")
    .map(mangle);
  args.splice(1, 0, "--target=node");
  const built = spawnSync("bun", args, { cwd: packageRoot, encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  return outFile;
}

test("--print-namespace prints srt's Windows namespace without starting the server", () => {
  // Run from source with no build-time define: srt falls back to upstream's namespace, so the
  // flag reports the effective value rather than a constant of its own.
  const namespace = printedNamespace(join(packageRoot, "node_modules/.bin/tsx"), [
    "src/main.ts",
    "--print-namespace",
  ]);
  assert.equal(namespace, "sandbox-runtime");
});

test(
  "the build's --define is what --print-namespace reports",
  { skip: hasBun ? false : "bun is not installed" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "sidecar-namespace-"));
    try {
      const bundle = bundleWithDefine(dir, (arg) => arg);
      assert.equal(printedNamespace(process.execPath, [bundle, "--print-namespace"]), "sourceweft");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a --define that lost its quotes silently builds the upstream namespace, and the flag shows it",
  { skip: hasBun ? false : "bun is not installed" },
  () => {
    // The Windows quoting trap: a command line that strips the double quotes turns the define's
    // string value into an identifier. The build still succeeds; only a runtime check notices.
    const dir = mkdtempSync(join(tmpdir(), "sidecar-namespace-"));
    try {
      const bundle = bundleWithDefine(dir, (arg) => arg.replaceAll('"', ""));
      assert.notEqual(
        printedNamespace(process.execPath, [bundle, "--print-namespace"]),
        "sourceweft",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
