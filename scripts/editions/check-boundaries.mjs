import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
const root = process.cwd();
const edition = process.argv[2];
assert.ok(
  ["core", "commercial"].includes(edition),
  "Specify core or commercial",
);
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter(
        (e) =>
          !["node_modules", ".next", "dist", ".git", "coverage"].includes(
            e.name,
          ),
      )
      .map((e) =>
        e.isDirectory()
          ? files(path.join(dir, e.name))
          : [path.join(dir, e.name)],
      ),
  );
  return nested.flat();
}
if (edition === "core") {
  await assert.rejects(stat(path.join(root, "enterprise")), { code: "ENOENT" });
  await assert.rejects(
    stat(path.join(root, "apps/web/app/dashboard/billing")),
    {
      code: "ENOENT",
    },
  );
  for (const dir of ["apps/backend/src", "apps/web", "packages"]) {
    for (const file of await files(path.join(root, dir))) {
      if (!/\.(?:ts|tsx|json)$/.test(file) || file.endsWith(".test.ts"))
        continue;
      const text = await readFile(file, "utf8");
      assert.ok(
        !/from\s*["']@sourceweft\/billing|import\s*\(["']@sourceweft\/billing|["']@creem_io\/better-auth/.test(
          text,
        ),
        `Commercial dependency in core: ${file}`,
      );
    }
  }
} else {
  for (const route of ["page.tsx", "checkout/page.tsx"]) {
    assert.ok(
      (
        await stat(path.join(root, "apps/web/app/dashboard/billing", route))
      ).isFile(),
    );
  }
  for (const file of await files(path.join(root, "enterprise/billing/src"))) {
    if (!/\.tsx?$/.test(file)) continue;
    const text = await readFile(file, "utf8");
    for (const m of text.matchAll(/(?:from\s*|import\s*\()["']([^"']+)/g)) {
      if (m[1].startsWith("."))
        assert.ok(
          path
            .resolve(path.dirname(file), m[1])
            .startsWith(path.join(root, "enterprise/billing") + path.sep),
          `Application import in billing: ${file}`,
        );
    }
  }
}
console.log(`PASS: ${edition} billing source dependency boundary`);
