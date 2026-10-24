import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const appRequire = (name) =>
  createRequire(path.join(root, `apps/${name}/package.json`));
const backend = appRequire("backend");
const web = appRequire("web");
const docs = appRequire("docs");

function verifyVersion(parent, name, version, entry = name) {
  let directory = path.dirname(parent.resolve(entry));
  while (directory !== path.dirname(directory)) {
    const metadataPath = path.join(directory, "package.json");
    if (existsSync(metadataPath)) {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      if (metadata.name === name) {
        assert.ok(
          realpathSync(metadataPath).startsWith(realpathSync(root) + path.sep),
        );
        assert.equal(
          metadata.version,
          version,
          `${name} must use the reviewed security patch`,
        );
        return;
      }
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot identify installed package ${name}`);
}

for (const app of [web, docs]) verifyVersion(app, "next", "16.4.2");
for (const app of [backend, web]) {
  verifyVersion(app, "sharp", "0.35.5");
  verifyVersion(app, "vitest", "4.1.12");
  verifyVersion(app, "@vitest/coverage-v8", "4.1.12");
  const vitest = createRequire(app.resolve("vitest/package.json"));
  verifyVersion(vitest, "@vitest/mocker", "4.1.12");
  verifyVersion(vitest, "vite", "8.3.5");
}
verifyVersion(backend, "hono", "4.13.13");
verifyVersion(
  backend,
  "@modelcontextprotocol/sdk",
  "1.32.1",
  "@modelcontextprotocol/sdk/client/index.js",
);
// GHSA-27r3-jxmh-p828: body-parser is reached only through the MCP SDK's
// express transport; the backend itself serves HTTP through Hono.
const sdk = createRequire(
  backend.resolve("@modelcontextprotocol/sdk/client/index.js"),
);
const express = createRequire(sdk.resolve("express"));
verifyVersion(express, "body-parser", "2.4.0");
// A compressed body followed by trailing bytes used to reach the finished
// decoder after the parser had handed over, and the late error escaped as an
// uncaught exception. The patched parser reports it to the route instead.
{
  const bodyParser = express("body-parser");
  const parseJson = bodyParser.json();
  const request = (buffer, encoding) => {
    const stream = Readable.from([buffer]);
    stream.headers = {
      "content-type": "application/json",
      "content-length": String(buffer.length),
      "content-encoding": encoding,
    };
    stream.method = "POST";
    stream.url = "/";
    return stream;
  };
  const frame = gzipSync(Buffer.from(JSON.stringify({ hello: "world" })));
  let escaped;
  const onUncaught = (error) => {
    escaped = error;
  };
  process.on("uncaughtException", onUncaught);
  try {
    const trailing = request(
      Buffer.concat([frame, Buffer.from("trailing-bytes")]),
      "gzip",
    );
    const reported = await new Promise((resolve) =>
      parseJson(trailing, {}, resolve),
    );
    assert.equal(reported?.status, 400, "trailing bytes must become a 400");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(escaped, undefined, "the decoder error must not escape");
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  const clean = request(frame, "gzip");
  assert.equal(
    await new Promise((resolve) => parseJson(clean, {}, resolve)),
    undefined,
  );
  assert.deepEqual(clean.body, { hello: "world" });
}
// GHSA-mrhx-c7xc-m3w5 covers every zod release before 4.6.6, so the 3.x line
// that shadcn 3 used to bring is gone as well; both remaining consumers are
// held to the reviewed release.
verifyVersion(backend, "zod", "4.6.7");
const ui = createRequire(path.join(root, "packages/ui/package.json"));
const shadcn = createRequire(ui.resolve("shadcn"));
verifyVersion(shadcn, "zod", "4.6.7");
// An oversized collection must fail on its size check alone instead of
// collecting one issue per element; the vulnerable releases return 200001.
{
  const { z } = backend("zod");
  const bounded = z.array(z.number()).max(10);
  const oversized = bounded.safeParse(new Array(200000).fill("x"));
  assert.equal(oversized.success, false);
  assert.deepEqual(
    oversized.error.issues.map((issue) => issue.code),
    ["too_big"],
  );
  assert.deepEqual(bounded.safeParse([1, 2]).data, [1, 2]);
}
// follow-redirects is reached only through axios (via @anycrawl/js-sdk).
const anycrawl = createRequire(backend.resolve("@anycrawl/js-sdk"));
const axios = createRequire(anycrawl.resolve("axios"));
verifyVersion(axios, "follow-redirects", "1.16.1");

// Resolve YAML through an actual affected consumer, not an extra test dependency.
const eslint = createRequire(web.resolve("eslint"));
const eslintrc = createRequire(eslint.resolve("@eslint/eslintrc"));
verifyVersion(eslintrc, "js-yaml", "4.3.2");
const yaml = eslintrc("js-yaml");
const emptyMerge = "sources: &sources [{}, {}, {}]\nresult:\n  <<: *sources\n";
assert.throws(
  () => yaml.load(emptyMerge, { maxTotalMergeKeys: 2 }),
  /maxTotalMergeKeys/,
);
assert.deepEqual(
  yaml.load(
    "defaults: &defaults {enabled: true}\nservice: {<<: *defaults, port: 3000}",
  ),
  {
    defaults: { enabled: true },
    service: { enabled: true, port: 3000 },
  },
);

// Check the native library actually loaded by both Next and the upload backend.
// GHSA-2464-fhr4-w9xw (SVG through the Image Optimization API) is fixed by
// sharp 0.35.5 under Next; the SVG decode below exercises that binary.
const next = createRequire(web.resolve("next/package.json"));
verifyVersion(next, "sharp", "0.35.5");
for (const parent of [backend, next]) {
  const sharp = parent("sharp");
  assert.equal(
    sharp.versions.heif,
    "1.23.5",
    "the loaded native decoder must be patched",
  );
  // GHSA-wq5f-xc86-pv6w: exercise the actual librsvg decoder shipped
  // by the patched sharp binary, in addition to the existing AVIF path.
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="red"/></svg>',
  );
  const svgPng = await sharp(svg).png().toBuffer();
  const svgMetadata = await sharp(svgPng).metadata();
  assert.equal(svgMetadata.format, "png");
  assert.equal(svgMetadata.width, 8);
  assert.equal(svgMetadata.height, 6);
  const avif = await sharp({
    create: { width: 8, height: 6, channels: 3, background: "white" },
  })
    .avif()
    .toBuffer();
  const png = await sharp(avif).png().toBuffer();
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 8);
  assert.equal(metadata.height, 6);
}

// Next 16.3.3 bypassed AVIF decoding as its security mitigation; 16.3.8 and
// later decode it again, through the sharp whose native decoder is pinned above.
// Both AVIF and ordinary images must resize through the patched optimizer.
const sharp = next("sharp");
const { imageOptimizer } = web("next/dist/server/image-optimizer");
const { defaultConfig } = web("next/dist/server/config-shared");
const avif = await sharp({
  create: { width: 8, height: 6, channels: 3, background: "white" },
})
  .avif()
  .toBuffer();
const optimized = await imageOptimizer(
  { buffer: avif, etag: "test-avif", cacheControl: "max-age=60" },
  { href: "/test.avif", width: 4, quality: 75, mimeType: "image/webp" },
  defaultConfig,
  { isDev: false, silent: true },
);
assert.equal(optimized.error, undefined);
assert.equal(optimized.contentType, "image/webp");
assert.equal((await sharp(optimized.buffer).metadata()).width, 4);
const pngInput = await sharp(avif).png().toBuffer();
const resized = await imageOptimizer(
  { buffer: pngInput, etag: "test-png", cacheControl: "max-age=60" },
  { href: "/test.png", width: 4, quality: 75, mimeType: "image/webp" },
  defaultConfig,
  { isDev: false, silent: true },
);
assert.equal(resized.error, undefined);
assert.equal(resized.contentType, "image/webp");
assert.equal((await sharp(resized.buffer).metadata()).width, 4);

// Fragment content must not become query parameters visible to Hono.
const { Hono } = backend("hono");
const app = new Hono();
app.get("/", (context) => context.json(context.req.query()));
assert.deepEqual(
  await (await app.request("http://localhost/#?injected=1")).json(),
  {},
);
assert.deepEqual(
  await (await app.request("http://localhost/?safe=1#&injected=1")).json(),
  { safe: "1" },
);
const { parseBody } = backend("hono/utils/body");
const formRequest = (fields) =>
  new Request("http://localhost/", {
    method: "POST",
    body: new URLSearchParams(fields),
  });
await assert.rejects(
  parseBody(formRequest({ [Array(40).fill("nested").join(".")]: "value" }), {
    dot: true,
  }),
  /Nesting limit exceeded/,
);
const normalBody = await parseBody(formRequest({ "user.name": "test" }), {
  dot: true,
});
assert.equal(normalBody.user.name, "test");
console.log(
  "Security patch versions, YAML merge budget, native AVIF decoding, Next optimization and Hono query/body boundaries passed.",
);
