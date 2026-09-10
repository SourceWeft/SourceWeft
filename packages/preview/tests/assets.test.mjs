import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packageRoot = dirname(
  require.resolve("@file-viewer/assets-ppt/package.json"),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

it("ships every declared PPT asset and preserves the original licensed runtime byte for byte", async () => {
  const target = await mkdtemp(join(tmpdir(), "sourceweft-preview-assets-"));
  try {
    const copy = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/copy-assets.mjs", import.meta.url)),
        target,
      ],
      { encoding: "utf8" },
    );
    expect(copy.status, copy.stderr).toBe(0);
    const manifest = JSON.parse(
      await readFile(
        join(packageRoot, "viewer/file-viewer-asset-pack.json"),
        "utf8",
      ),
    );
    for (const renderer of manifest.rendererAssetManifests) {
      for (const asset of renderer.assets.filter((asset) => asset.required)) {
        expect(
          (await readFile(join(target, asset.defaultPath))).length,
        ).toBeGreaterThan(0);
      }
    }
    const original = join(packageRoot, "viewer/vendor/ppt");
    for (const name of await readdir(original)) {
      expect(
        digest(await readFile(join(target, "vendor/ppt", name))),
        name,
      ).toBe(digest(await readFile(join(original, name))));
    }
    expect(
      await readFile(join(target, "vendor/ppt/LICENSE"), "utf8"),
    ).toContain("Public Watermarked Runtime License");
    expect(await readFile(join(target, "vendor/ppt/NOTICE"), "utf8")).toContain(
      "NOT OPEN SOURCE",
    );
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
