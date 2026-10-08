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
const tsMorph = createRequire(shadcn.resolve("ts-morph"));
const tsMorphCommon = createRequire(tsMorph.resolve("@ts-morph/common"));
const minimatch10 = createRequire(tsMorphCommon.resolve("minimatch"));
const eslintConfig = createRequire(
  path.join(root, "packages/eslint-config/package.json"),
);
const eslint = createRequire(eslintConfig.resolve("eslint"));
const minimatch3 = createRequire(eslint.resolve("minimatch"));
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

const uri = patchedDependency(ajv, "fast-uri", "3.1.8");
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
// GHSA-hrr3-gc8f-f4qj: a percent-encoded host in a scheme-relative reference
// is case-folded like its literal spelling, so host checks cannot be evaded.
assert.equal(uri.parse("//%41.com").host, "a.com");
assert.equal(uri.equal("//%41.com", "//a.com"), true);

const { Address4, Address6 } = patchedDependency(
  rateLimit,
  "ip-address",
  "10.7.2",
);
// GHSA-rpw4-54j3-4h4q: link-local is the whole fe80::/10.
for (const value of ["fe80::1", "fe81::1", "febf::1"]) {
  assert.equal(new Address6(value).isLinkLocal(), true, value);
}
assert.equal(new Address6("fec0::1").isLinkLocal(), false);
// GHSA-2vr4-cq9g-pvrc: the NAT64 local-use prefix 64:ff9b:1::/48 is private.
for (const value of ["64:ff9b:1:7f00:0:100::", "64:ff9b:1:a9fe:a9:fe00::"]) {
  assert.equal(new Address6(value).isPrivate(), true, value);
}
assert.equal(new Address6("2001:4860:4860::8888").isPrivate(), false);
// GHSA-j6r3-76f7-8jcv: an address is never inside a network of the other
// family, even when the leading bits agree.
assert.equal(
  new Address6("a00::1").isInSubnet(new Address4("10.0.0.0/8")),
  false,
);
assert.equal(
  new Address4("32.0.0.1").isInSubnet(new Address6("2000::/3")),
  false,
);
assert.equal(
  new Address4("10.1.2.3").isInSubnet(new Address4("10.0.0.0/8")),
  true,
);
assert.equal(
  new Address6("2001:db8::1").isInSubnet(new Address6("2001:db8::/32")),
  true,
);
// GHSA-h3mg-xc3c-68pw: an oversized string is rejected before the parser
// builds a diagnostic proportional to it.
assert.throws(
  () => new Address6("!".repeat(1 << 20)),
  (error) =>
    error.name === "AddressError" &&
    error.message.length < 100 &&
    !error.parseMessage,
);
assert.equal(Address6.isValid("1".repeat(1 << 20)), false);
assert.equal(
  new Address6("0000:0000:0000:0000:0000:ffff:255.255.255.255/56").subnetMask,
  56,
);

// brace-expansion ships two lines: 5.x under minimatch 10 (production, through
// shadcn and ts-morph) and 1.x under minimatch 3 (eslint).
const braceExpansionLines = [
  [
    "5.0.12",
    patchedDependency(minimatch10, "brace-expansion", "5.0.12").expand,
  ],
  ["1.1.21", patchedDependency(minimatch3, "brace-expansion", "1.1.21")],
];
for (const [version, expand] of braceExpansionLines) {
  const label = "brace-expansion " + version + ": ";
  // GHSA-6j4f-fj2g-mc7p and GHSA-qhr7-859c-m2p7: chained, comma-heavy and
  // nested groups must not exhaust the stack.
  for (const [name, pattern] of [
    ["chained groups", "{" + "{a},".repeat(7000) + "b}"],
    ["one large comma set", "{{x}," + "a,".repeat(125000) + "b}"],
    ["nested comma members", "{a,".repeat(4000) + "z" + "}".repeat(4000)],
    ["nested single set", "{".repeat(3200) + "a,b" + "}".repeat(3200)],
  ]) {
    assert.doesNotThrow(() => expand(pattern), label + name);
  }
  // GHSA-q2hr-2g5m-vwhr: each `{a},b}` rewrite rescans the whole pattern, so
  // the patched releases cap the rewrites and return the rest literally. The
  // vulnerable releases take several seconds on this input and patched ones
  // take milliseconds, so the bound leaves room for a slow runner.
  const started = Date.now();
  expand("{a}" + "}".repeat(64000) + ",z}");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, label + "`{a},b}` rewrite took " + elapsed + "ms");
  // Ordinary patterns keep their Bash semantics.
  assert.deepEqual(expand("a{b,c{d,e}}f{1..3}"), [
    "abf1",
    "abf2",
    "abf3",
    "acdf1",
    "acdf2",
    "acdf3",
    "acef1",
    "acef2",
    "acef3",
  ]);
  assert.deepEqual(expand("{a},b}"), ["a}", "b"]);
  assert.deepEqual(expand("src/**/*.{ts,tsx}"), [
    "src/**/*.ts",
    "src/**/*.tsx",
  ]);
}

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

// The formerly vulnerable braces implementation must resolve through the
// actual SDK consumer chain, including its normal glob behavior.
require("./verify-security-braces.cjs");

// Handlebars 4.7.10 fixes the AST validation bypass in GHSA-8r5x-fm3f-whwj.
const parsers = createRequire(
  path.join(root, "packages/builtin-document-parsers/package.json"),
);
const classic = createRequire(
  parsers.resolve("@langchain/classic/package.json"),
);
const handlebars = patchedDependency(classic, "handlebars", "4.7.10");
assert.equal(
  handlebars.compile("Hello {{name}}")({ name: "<world>" }),
  "Hello &lt;world&gt;",
);
const invalidAst = {
  type: "Program",
  body: [
    {
      type: "BlockStatement",
      path: {
        type: "PathExpression",
        data: false,
        depth: 0,
        parts: ["missingHelper"],
        original: "missingHelper",
      },
      params: [],
      program: {
        type: "Program",
        blockParams: {
          length: "(globalThis.__swHandlebarsInjected = true, 0)",
        },
        body: [],
      },
      openStrip: { open: false, close: false },
      inverseStrip: { open: false, close: false },
      closeStrip: { open: false, close: false },
    },
  ],
};
const astLocation = {
  start: { line: 1, column: 0 },
  end: { line: 1, column: 20 },
};
invalidAst.loc = astLocation;
invalidAst.body[0].loc = astLocation;
invalidAst.body[0].path.loc = astLocation;
invalidAst.body[0].program.loc = astLocation;
globalThis.__swHandlebarsInjected = false;
try {
  assert.throws(() => handlebars.compile(invalidAst)({}));
  assert.equal(
    globalThis.__swHandlebarsInjected,
    false,
    "Invalid AST must never execute JavaScript",
  );
} finally {
  delete globalThis.__swHandlebarsInjected;
}

console.log("Handlebars patch and normal template behavior verified.");
