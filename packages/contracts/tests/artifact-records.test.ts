import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARTIFACT_RECORD_LIMITS,
  artifactRecordApiErrorCode,
  artifactRecordErrorCodeFromApi,
  artifactRecordOperationSchema,
  artifactRecordRequestSchema,
  checkArtifactRecordData,
  describeArtifactLinkHost,
  parseArtifactExternalUrl,
} from "../src/artifact-records";
import {
  buildArtifactRuntimeScript,
  injectArtifactRuntime,
} from "../src/artifact-runtime";
import {
  htmlArtifactMetadataSchema,
  htmlArtifactRecordCapabilities,
} from "../src/html-artifact";

test("record data accepts JSON values and reports their UTF-8 size", () => {
  const result = checkArtifactRecordData({
    title: "café",
    tags: ["a", 1, true, null],
  });
  assert.equal(result.ok, true);
  assert.equal(
    result.ok && result.sizeBytes,
    Buffer.byteLength(
      JSON.stringify({ title: "café", tags: ["a", 1, true, null] }),
    ),
  );
});

test("record data rejects what jsonb cannot store", () => {
  for (const value of [
    "a\u0000b",
    { "\u0000": 1 },
    "\ud800",
    "x\udc00",
    { key: "\ud83d" },
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
    () => 1,
    new Date(),
    new Map(),
  ]) {
    assert.equal(checkArtifactRecordData(value).ok, false, String(value));
  }
  assert.equal(checkArtifactRecordData("😀").ok, true);
});

test("record data bounds nesting depth and size", () => {
  let nested: unknown = 1;
  for (let depth = 1; depth < ARTIFACT_RECORD_LIMITS.maxDepth; depth++)
    nested = [nested];
  assert.equal(checkArtifactRecordData(nested).ok, true);
  assert.equal(checkArtifactRecordData([nested]).ok, false);
  assert.equal(
    checkArtifactRecordData("x".repeat(ARTIFACT_RECORD_LIMITS.recordBytes)).ok,
    false,
  );
});

test("operations are strict and carry no host-owned fields", () => {
  assert.equal(
    artifactRecordOperationSchema.safeParse({
      op: "get",
      collection: "kv",
      id: "a",
      ownerUserId: "someone-else",
    }).success,
    false,
  );
  assert.equal(
    artifactRecordOperationSchema.safeParse({
      op: "get",
      scope: "team",
      collection: "kv",
      id: "a",
    }).success,
    false,
  );
  const parsed = artifactRecordOperationSchema.parse({
    op: "query",
    collection: "tasks",
  });
  assert.deepEqual(parsed, {
    op: "query",
    scope: "user",
    collection: "tasks",
    where: [],
    orderBy: [],
    limit: ARTIFACT_RECORD_LIMITS.queryDefaultLimit,
  });
  assert.equal(
    artifactRecordRequestSchema.safeParse({
      versionId: "v1",
      artifactId: "other",
      operation: { op: "get", collection: "kv", id: "a" },
    }).success,
    false,
  );
});

test("names and paths cannot smuggle SQL or JSON path syntax", () => {
  for (const collection of ["", "a b", "x'--", "a".repeat(65)])
    assert.equal(
      artifactRecordOperationSchema.safeParse({
        op: "get",
        collection,
        id: "a",
      }).success,
      false,
      collection,
    );
  for (const path of ["a..b", "$.a", "a[0]", "a'b", "a.b.c.d.e.f.g.h.i", ""])
    assert.equal(
      artifactRecordOperationSchema.safeParse({
        op: "query",
        collection: "c",
        where: [{ path, op: "exists" }],
      }).success,
      false,
      path,
    );
  assert.equal(
    artifactRecordOperationSchema.safeParse({
      op: "query",
      collection: "c",
      where: [{ path: "a", op: "lt", value: { nested: true } }],
    }).success,
    false,
  );
});

test("API error codes round-trip to the page's short codes", () => {
  assert.equal(
    artifactRecordApiErrorCode("consent_required"),
    "ARTIFACT_RECORD_CONSENT_REQUIRED",
  );
  assert.equal(
    artifactRecordErrorCodeFromApi("ARTIFACT_RECORD_CONSENT_REQUIRED"),
    "consent_required",
  );
  assert.equal(
    artifactRecordErrorCodeFromApi("VALIDATION_ERROR"),
    "invalid_request",
  );
  assert.equal(
    artifactRecordErrorCodeFromApi("ARTIFACT_RECORD_NOPE"),
    "unavailable",
  );
  assert.equal(artifactRecordErrorCodeFromApi(undefined), "unavailable");
});

test("only http and https links may leave an artifact", () => {
  assert.equal(
    parseArtifactExternalUrl("https://example.com/a?b=1")?.hostname,
    "example.com",
  );
  assert.equal(
    parseArtifactExternalUrl("http://example.com")?.protocol,
    "http:",
  );
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "blob:https://example.com/x",
    "file:///etc/passwd",
    "/relative",
    "mailto:a@example.com",
  ])
    assert.equal(parseArtifactExternalUrl(value), null, value);
});

test("capabilities are declared in metadata; shared implies storage", () => {
  assert.equal(
    htmlArtifactMetadataSchema.safeParse({
      schemaVersion: 1,
      capabilities: ["storage", "storage"],
    }).success,
    false,
  );
  assert.equal(
    htmlArtifactMetadataSchema.safeParse({
      schemaVersion: 1,
      capabilities: ["network"],
    }).success,
    false,
  );
  assert.deepEqual(
    htmlArtifactRecordCapabilities({ metadata: { schemaVersion: 1 } }),
    {
      storage: false,
      shared: false,
    },
  );
  assert.deepEqual(
    htmlArtifactRecordCapabilities({
      metadata: { schemaVersion: 1, capabilities: ["storage.shared"] },
    }),
    { storage: true, shared: true },
  );
  assert.deepEqual(htmlArtifactRecordCapabilities({ metadata: "bad" }), {
    storage: false,
    shared: false,
  });
});

test("runtime script compiles for both storage modes", () => {
  for (const storage of [true, false]) {
    const script = buildArtifactRuntimeScript({ storage });
    assert.doesNotThrow(() => new Function(script));
    assert.equal(/<\/script/iu.test(script), false);
  }
});

test("runtime is injected right after the html start tag", () => {
  const html =
    '﻿<!-- <html lang="fake"> -->\n<!doctype html>\n<html lang="en" data-x="a>b"><head></head><body></body></html>';
  const injected = injectArtifactRuntime(html, "void 0");
  assert.ok(injected);
  assert.ok(
    injected.startsWith(
      '﻿<!-- <html lang="fake"> -->\n<!doctype html>\n<html lang="en" data-x="a>b"><script data-sourceweft-runtime>void 0</script><head>',
    ),
  );
  assert.equal(
    injectArtifactRuntime(
      "<!DOCTYPE html><HTML><body></body></HTML>",
      "1",
    )?.includes("<HTML><script data-sourceweft-runtime>1</script><body>"),
    true,
  );
});

test("runtime injection fails closed on unexpected documents", () => {
  assert.equal(injectArtifactRuntime("text<html></html>", "1"), null);
  assert.equal(injectArtifactRuntime("<!-- unterminated <html>", "1"), null);
  assert.equal(injectArtifactRuntime('<html lang="x', "1"), null);
  assert.equal(injectArtifactRuntime("<htmlx></htmlx>", "1"), null);
  assert.equal(injectArtifactRuntime("<html></html>", "</script>"), null);
});

test("link hosts are shown in both their ASCII and Unicode forms", () => {
  assert.deepEqual(describeArtifactLinkHost("example.com"), {
    ascii: "example.com",
    unicode: "example.com",
    isInternationalized: false,
  });
  assert.deepEqual(describeArtifactLinkHost("xn--mnchen-3ya.de"), {
    ascii: "xn--mnchen-3ya.de",
    unicode: "münchen.de",
    isInternationalized: true,
  });
  assert.equal(
    describeArtifactLinkHost("xn--fiqs8s.xn--fiqz9s").unicode,
    "中国.中國",
  );
  // Cyrillic "а" posing as Latin "a" in "apple".
  assert.equal(
    describeArtifactLinkHost("xn--pple-43d.com").unicode,
    "аpple.com",
  );
  assert.equal(
    describeArtifactLinkHost(new URL("https://bücher.example").hostname)
      .unicode,
    "bücher.example",
  );
  assert.equal(describeArtifactLinkHost("xn--!!.com").unicode, "xn--!!.com");
});
