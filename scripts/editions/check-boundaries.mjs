import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
const root = process.cwd();
for (const app of ["backend", "web"]) {
  const manifest = JSON.parse(
    await readFile(`apps/${app}/package.json`, "utf8"),
  );
  assert.equal(manifest.dependencies["@sourceweft/billing"], "workspace:*");
}
const bindings = await readFile(
  "apps/backend/src/billing-host/bindings.ts",
  "utf8",
);
assert.match(bindings, /resolveCommercialEnabled\(process.env\)/);
assert.match(bindings, /await import\("\.\/commercial"\)/);
assert.doesNotMatch(
  bindings,
  /catch\s*\(/,
  "Never downgrade after an enabled module fails",
);
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await check(file);
      continue;
    }
    if (!/\.tsx?$/.test(file)) continue;
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/(?:from\s*|import\s*\()["']([^"']+)/g)) {
      if (match[1].startsWith("."))
        assert.ok(
          path
            .resolve(path.dirname(file), match[1])
            .startsWith(path.join(root, "enterprise/billing") + path.sep),
          `Application import in billing: ${file}`,
        );
    }
  }
}
await check(path.join(root, "enterprise/billing/src"));
console.log("PASS: unified module dependency boundary");
