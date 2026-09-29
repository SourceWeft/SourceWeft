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
const rateLimit = createRequire(sdk.resolve("express-rate-limit"));
const ui = createRequire(path.join(root, "packages/ui/package.json"));
const shadcn = createRequire(ui.resolve("shadcn"));
const dotenvx = createRequire(shadcn.resolve("@dotenvx/dotenvx"));
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

const uri = patchedDependency(ajv, "fast-uri", "3.1.7");
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
// GHSA-qw65-cvwx-89v3: a port that is not digits must not inject authority.
let serialized;
try {
  serialized = uri.serialize({
    scheme: "http",
    host: "trusted.example",
    port: "@127.0.0.1:8124",
    path: "/app",
  });
} catch {
  serialized = undefined;
}
assert.ok(
  serialized === undefined ||
    new URL(serialized).hostname === "trusted.example",
  "A malformed port must not move the authority: " + serialized,
);
// GHSA-58mr-gqgx-xq4g: an unclosed bracket in the host is reported rather
// than returned as a host that no HTTP client would reach, and a bracket that
// parses cleanly names the host a client does reach.
for (const value of [
  "http://[127.0.0.1/app",
  "http://[evil.example/",
  "http://a@[127.0.0.1/",
]) {
  assert.ok(
    uri.parse(value).error,
    "An unclosed bracket in the host must be reported: " + value,
  );
}
assert.equal(
  uri.parse("http://[@127.0.0.1/").host,
  new URL("http://[@127.0.0.1/").hostname,
);

const { Address6 } = patchedDependency(rateLimit, "ip-address", "10.5.1");
// GHSA-rpw4-54j3-4h4q: link-local is the whole fe80::/10.
for (const value of ["fe80::1", "fe81::1", "febf::1"]) {
  assert.equal(new Address6(value).isLinkLocal(), true, value);
}
assert.equal(new Address6("fec0::1").isLinkLocal(), false);
// GHSA-2vr4-cq9g-pvrc: the NAT64 local-use prefix 64:ff9b:1::/48 is private.
for (const value of [
  "64:ff9b:1:7f00:0:100::",
  "64:ff9b:1:a9fe:a9:fe00::",
]) {
  assert.equal(new Address6(value).isPrivate(), true, value);
}
assert.equal(new Address6("2001:4860:4860::8888").isPrivate(), false);

// GHSA-3wwx-pv8p-q78v: the WebSocket crash is not safely reproducible here, so
// both undici lines are held to their reviewed patch releases.
patchedDependency(backend, "undici", "6.28.1");
patchedDependency(dotenvx, "undici", "7.29.1");

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
  "Patched npm dependency versions and their advisory regressions passed.",
);
