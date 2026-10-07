const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const root = path.resolve(__dirname, "../..");
const backend = createRequire(path.join(root, "apps/backend/package.json"));
const daytonaAdapter = createRequire(backend.resolve("@langchain/daytona"));
const daytona = createRequire(daytonaAdapter.resolve("@daytona/sdk"));
const fastGlob = createRequire(daytona.resolve("fast-glob"));
const micromatch = createRequire(fastGlob.resolve("micromatch"));
const maintained = micromatch("braces");
assert.equal(
  micromatch("braces/package.json").name,
  "@sourceweft/security-braces",
);
assert.equal(micromatch("braces/package.json").version, "3.0.3-sourceweft.1");
assert.ok(
  fs.realpathSync(micromatch.resolve("braces")).startsWith(root + path.sep),
);
assert.deepEqual(maintained.expand("file-{1..3}.{txt,md}"), [
  "file-1.txt",
  "file-1.md",
  "file-2.txt",
  "file-2.md",
  "file-3.txt",
  "file-3.md",
]);
const hostile = "{".repeat(1000) + "a,b" + "}".repeat(1000);
assert.throws(() => fastGlob("micromatch").braces(hostile), SyntaxError);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-braces-"));
try {
  for (const name of ["one.txt", "two.md", "ignored.csv"])
    fs.writeFileSync(path.join(dir, name), name);
  assert.deepEqual(
    daytona("fast-glob").sync("*.{txt,md}", { cwd: dir }).sort(),
    ["one.txt", "two.md"],
  );
  assert.throws(
    () => daytona("fast-glob").sync(hostile, { cwd: dir }),
    SyntaxError,
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(
  "Maintained braces security and normal glob behavior verified through the actual Daytona SDK dependency chain.",
);
