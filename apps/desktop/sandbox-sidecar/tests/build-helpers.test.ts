import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REQUIRED_BUN_VERSION,
  assertBunVersion,
  bunCompileArgs,
} from "../scripts/manifest.js";

test("assertBunVersion accepts exactly the required version", () => {
  assert.doesNotThrow(() => assertBunVersion(REQUIRED_BUN_VERSION));
});

test("assertBunVersion rejects an older Bun loudly, naming the version and requirement", () => {
  // The E2E trap: the build ran under Bun 1.2.14 and compiled a dead bundle. The guard must stop
  // it with a message naming both the installed version and what is required.
  assert.throws(
    () => assertBunVersion("1.2.14"),
    (error: Error) => {
      assert.match(error.message, /1\.2\.14/);
      assert.match(error.message, new RegExp(REQUIRED_BUN_VERSION.replace(/\./g, "\\.")));
      return true;
    },
  );
});

test("assertBunVersion rejects a newer-but-untested Bun and a non-Bun runtime", () => {
  assert.throws(() => assertBunVersion("1.4.5"), /1\.4\.5/);
  // Run with node (no process.versions.bun): the failure says so rather than being a mystery.
  assert.throws(() => assertBunVersion(undefined), /no Bun/);
});

test("bunCompileArgs: native build omits --target (byte-identical to the historical compile)", () => {
  assert.deepEqual(
    bunCompileArgs({ entry: "/pkg/src/main.ts", outFile: "/pkg/dist/bundle/srt-sidecar", crossTarget: undefined }),
    [
      "build",
      "--compile",
      "--define",
      '__SRT_WIN_NAMESPACE__="sourceweft"',
      "/pkg/src/main.ts",
      "--outfile",
      "/pkg/dist/bundle/srt-sidecar",
    ],
  );
});

test("bunCompileArgs: a same-OS cross build inserts exactly one --target=<bun target>", () => {
  const args = bunCompileArgs({
    entry: "/pkg/src/main.ts",
    outFile: "/pkg/dist/bundle/srt-sidecar",
    crossTarget: "bun-darwin-x64",
  });
  assert.deepEqual(args, [
    "build",
    "--compile",
    "--target=bun-darwin-x64",
    "--define",
    '__SRT_WIN_NAMESPACE__="sourceweft"',
    "/pkg/src/main.ts",
    "--outfile",
    "/pkg/dist/bundle/srt-sidecar",
  ]);
  assert.equal(args.filter((a) => a.startsWith("--target")).length, 1);
});
