import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const assetPairs = [
  ["src/modules/mail/templates", "dist/modules/mail/templates"],
  // The in-sandbox half of the MCP stdio validation (a plain Node script).
  [
    "src/modules/market/validation/stdio-driver.mjs",
    "dist/modules/market/validation/stdio-driver.mjs",
  ],
];

for (const [source, destination] of assetPairs) {
  const sourcePath = path.join(backendRoot, source);
  const destinationPath = path.join(backendRoot, destination);
  rmSync(destinationPath, { force: true, recursive: true });
  cpSync(sourcePath, destinationPath, { recursive: true });
}
