import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const assets = dirname(
  require.resolve("@file-viewer/assets-standard/package.json"),
);
if (!process.argv[2])
  throw new Error("Pass a destination directory for preview assets.");
const target = resolve(process.argv[2]);
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
const pptAssets = dirname(
  require.resolve("@file-viewer/assets-ppt/package.json"),
);
await mkdir(resolve(target, "vendor", "ppt"), { recursive: true });
await cp(
  resolve(pptAssets, "viewer/vendor/ppt"),
  resolve(target, "vendor/ppt"),
  {
    recursive: true,
  },
);
console.log(`Preview assets ready at ${target}`);
