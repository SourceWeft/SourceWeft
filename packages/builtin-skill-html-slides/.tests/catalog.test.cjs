const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const catalog = JSON.parse(
  fs.readFileSync(path.join(root, "runtime/catalog.json"), "utf8"),
);
test("all upstream themes, layouts, animations and FX are present under stable names", () => {
  assert.equal(catalog.themes.length, 36);
  assert.equal(catalog.layouts.length, 31);
  assert.equal(catalog.animations.length, 27);
  assert.equal(catalog.effects.length, 20);
  for (const [key, folder, ext] of [
    ["themes", "themes", "css"],
    ["layouts", "layouts", "html"],
    ["effects", "fx", "js"],
  ]) {
    assert.equal(new Set(catalog[key]).size, catalog[key].length);
    for (const id of catalog[key])
      assert.ok(
        fs.existsSync(path.join(root, "runtime", folder, id + "." + ext)),
      );
  }
  const registration = { window: {} };
  vm.createContext(registration);
  for (const name of catalog.effects) {
    const filename = path.join(root, "runtime/fx", name + ".js");
    vm.runInContext(fs.readFileSync(filename, "utf8"), registration, {
      filename,
      timeout: 1000,
    });
    assert.equal(
      typeof registration.window.HPX?.[name],
      "function",
      `Effect must register under its catalog name: ${name}`,
    );
  }
});
test("skill output and bounded text bundle are independent from its viewer", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "sourceweft.capability.json"), "utf8"),
  );
  assert.equal(manifest.skills[0].runtime.output.artifactType, "html");
  assert.equal(
    manifest.skills[0].runtime.output.publisherTool,
    "publish_artifact",
  );
  let bytes = 0,
    count = 0;
  function visit(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || ["node_modules", "dist"].includes(e.name))
        continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else {
        count++;
        bytes += fs.statSync(p).size;
        assert.ok(!/\.(ttf|woff2?)$/.test(e.name));
      }
    }
  }
  visit(root);
  assert.ok(count <= 200);
  assert.ok(bytes <= 2 * 1024 * 1024);
  assert.ok(!fs.existsSync(path.join(root, "src/ui")));
  assert.ok(!fs.existsSync(path.join(root, "runtime/fx-runtime.js")));
});
