import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
if (!process.argv[2]) throw new Error("Specify the pruned source directory");
const target = path.resolve(process.argv[2]);
await mkdir(path.join(target, "enterprise/billing/LICENSES"), {
  recursive: true,
});
for (const file of [
  "LICENSE",
  "enterprise/LICENSE",
  "enterprise/billing/LICENSE",
  "enterprise/billing/LICENSES/Apache-2.0.txt",
]) {
  await copyFile(file, path.join(target, file));
}
