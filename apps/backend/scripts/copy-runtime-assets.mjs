import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const assetPairs = [
  ["src/shared/mail/templates", "dist/shared/mail/templates"],
];

for (const [source, destination] of assetPairs) {
  const sourcePath = path.join(backendRoot, source);
  const destinationPath = path.join(backendRoot, destination);
  rmSync(destinationPath, { force: true, recursive: true });
  if (!existsSync(sourcePath)) {
    console.warn(`copy-runtime-assets: skipping missing ${source}`);
    continue;
  }
  cpSync(sourcePath, destinationPath, { recursive: true });
}
