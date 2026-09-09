import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const appRequire = (name) =>
  createRequire(path.join(root, `apps/${name}/package.json`));
const backend = appRequire("backend");
const web = appRequire("web");
const docs = appRequire("docs");

function verifyVersion(parent, name, version) {
  let directory = path.dirname(parent.resolve(name));
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

for (const app of [web, docs]) verifyVersion(app, "next", "16.3.3");
for (const app of [backend, web]) {
  verifyVersion(app, "sharp", "0.35.4");
  verifyVersion(app, "vitest", "4.1.11");
  verifyVersion(app, "@vitest/coverage-v8", "4.1.11");
  const vitest = createRequire(app.resolve("vitest/package.json"));
  verifyVersion(vitest, "@vitest/mocker", "4.1.11");
}
verifyVersion(backend, "hono", "4.13.5");

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
const next = createRequire(web.resolve("next/package.json"));
verifyVersion(next, "sharp", "0.35.4");
for (const parent of [backend, next]) {
  const sharp = parent("sharp");
  assert.equal(
    sharp.versions.heif,
    "1.23.2",
    "the loaded native decoder must be patched",
  );
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

// Next 16.3.3 bypasses AVIF decoding as its security mitigation.
// Ordinary images must still resize through the patched optimizer.
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
assert.equal(optimized.contentType, "image/avif");
assert.deepEqual(optimized.buffer, avif);
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
