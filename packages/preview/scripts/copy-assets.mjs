import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { FILE_VIEWER_ASSET_VERSION } from "../src/asset-base.mjs";

const require = createRequire(import.meta.url);
const assets = dirname(
  require.resolve("@file-viewer/assets-standard/package.json"),
);
if (!process.argv[2])
  throw new Error("Pass a destination directory for preview assets.");
const root = resolve(process.argv[2]);
const pptAssets = dirname(
  require.resolve("@file-viewer/assets-ppt/package.json"),
);
// The URL version must track the installed asset packages, or immutable
// caching would serve stale files after an upgrade.
const installed = `std-${JSON.parse(await readFile(resolve(assets, "package.json"), "utf8")).version}_ppt-${JSON.parse(await readFile(resolve(pptAssets, "package.json"), "utf8")).version}`;
if (installed !== FILE_VIEWER_ASSET_VERSION)
  throw new Error(
    `FILE_VIEWER_ASSET_VERSION is "${FILE_VIEWER_ASSET_VERSION}" but installed asset packages are "${installed}"; update src/asset-base.mjs.`,
  );
// Drop the unversioned legacy layout and any other version left behind.
for (const entry of await readdir(root).catch(() => []))
  if (entry !== FILE_VIEWER_ASSET_VERSION)
    await rm(resolve(root, entry), { recursive: true, force: true });
const target = resolve(root, FILE_VIEWER_ASSET_VERSION);
// Copy only the enabled document families, retaining their license files.
for (const family of ["pdf", "docx", "pptx", "xlsx"]) {
  await mkdir(resolve(target, "vendor", family), { recursive: true });
  await cp(
    resolve(assets, "viewer/vendor", family),
    resolve(target, "vendor", family),
    { recursive: true },
  );
}
// Legacy PPT is separately licensed. Preserve the complete official runtime,
// including its manifest, watermarks, LICENSE and NOTICE without transformation.
await mkdir(resolve(target, "vendor", "ppt"), { recursive: true });
await cp(
  resolve(pptAssets, "viewer/vendor/ppt"),
  resolve(target, "vendor/ppt"),
  {
    recursive: true,
  },
);
console.log(`Preview assets ready at ${target}`);
