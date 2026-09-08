import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
if (!process.argv[2]) throw new Error("Specify the pruned source directory");
const target = path.resolve(process.argv[2]);
const edition = JSON.parse(
  await readFile(".sourceweft-edition.json", "utf8"),
).edition;
await mkdir(target, { recursive: true });
await copyFile("LICENSE", path.join(target, "LICENSE"));
if (edition === "commercial") {
  await mkdir(path.join(target, "enterprise"), { recursive: true });
  await copyFile("enterprise/LICENSE", path.join(target, "enterprise/LICENSE"));
}
