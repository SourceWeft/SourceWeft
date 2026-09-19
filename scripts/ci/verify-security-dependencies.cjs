const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const root = path.resolve(__dirname, "../..");
const backend = createRequire(path.join(root, "apps/backend/package.json"));
const sdk = createRequire(
  backend.resolve("@modelcontextprotocol/sdk/client/index.js"),
);
const ajv = createRequire(sdk.resolve("ajv"));
const express = createRequire(sdk.resolve("express"));
const publisher = createRequire(
  path.join(root, "packages/builtin-tool-publish-artifact/package.json"),
);
const domToPptx = createRequire(publisher.resolve("dom-to-pptx"));
const fontEditor = createRequire(domToPptx.resolve("fonteditor-core"));

function patchedDependency(parent, name, version) {
  let directory = path.dirname(parent.resolve(name));
  while (directory !== path.dirname(directory)) {
    const metadata = path.join(directory, "package.json");
    if (fs.existsSync(metadata)) {
      const data = JSON.parse(fs.readFileSync(metadata, "utf8"));
      if (data.name === name) {
        assert.ok(
          fs
            .realpathSync(directory)
            .startsWith(fs.realpathSync(root) + path.sep),
        );
        assert.equal(
          data.version,
          version,
          name + " must use the reviewed security patch",
        );
        return parent(name);
      }
    }
    directory = path.dirname(directory);
  }
  throw new Error("Could not identify installed package " + name);
}

const uri = patchedDependency(ajv, "fast-uri", "3.1.6");
for (const value of [
  "http://[::not-valid]/private",
  "http://[fc00::not-hex]/private",
  "http://%256c%256f%2563%2561%256c%2568%256f%2573%2574/",
  "%2f%2fevil.example:/pwn",
  "%u002f%u002fevil.example:/pwn",
]) {
  assert.ok(
    uri.parse(value).error,
    "Invalid URI must carry an error: " + value,
  );
  assert.equal(
    uri.normalize(value),
    value,
    "Invalid input must not become a different authority",
  );
}
assert.equal(
  uri.resolve("https://safe.example/", "//bücher.example/"),
  "https://xn--bcher-kva.example/",
);

const qs = patchedDependency(express, "qs", "6.16.0");
assert.throws(
  () =>
    qs.parse("a[]=1,2,3,4", {
      comma: true,
      arrayLimit: 3,
      throwOnLimitExceeded: true,
    }),
  /Array limit exceeded/,
);
const hostileObject = qs.parse("a[constructor][isBuffer]=not-a-function", {
  plainObjects: true,
});
assert.equal(
  qs.stringify(hostileObject),
  "a%5Bconstructor%5D%5BisBuffer%5D=not-a-function",
);
assert.deepEqual(qs.parse("a[]=1,2", { comma: true, arrayLimit: 3 }), {
  a: [["1", "2"]],
});

const { DOMImplementation, XMLSerializer } = patchedDependency(
  fontEditor,
  "@xmldom/xmldom",
  "0.8.15",
);
const document = new DOMImplementation().createDocument(null, "root", null);
const serializer = new XMLSerializer();
assert.equal(
  serializer.serializeToString(document.createEntityReference("safe")),
  "&safe;",
);
assert.throws(
  () => document.createEntityReference("safe; <injected/> &x"),
  /Invalid character/,
);

console.log(
  "Patched npm dependency versions and all seven advisory regressions passed.",
);
