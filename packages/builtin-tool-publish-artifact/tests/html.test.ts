import assert from "node:assert/strict";
import { test } from "vitest";
import { createHash } from "node:crypto";
import { validateHtmlBytes } from "../src/html/validation";
import { handlerForArtifactType } from "../src/artifact-type-handlers";
import { PublishArtifactInputSchema } from "../src/schemas";
import { publishArtifact } from "../src/publisher";

const document = (body: string, head = "") =>
  Buffer.from(
    `<!doctype html><html lang="zh"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`,
  );

test("ordinary producer HTML passes without a skill, slide metadata or protocol", () => {
  const bytes = document(
    '<h1>你好</h1><button onclick="this.textContent=42">Count</button>',
  );
  const result = validateHtmlBytes(bytes);
  assert.deepEqual(result.metadata, { schemaVersion: 1 });
  assert.equal(
    result.contentDigest,
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );
  assert.ok(handlerForArtifactType("html"));
});

test("HTML validation rejects missing resources across parsed HTML and CSS", () => {
  for (const [body, head] of [
    ['<img src="missing.png">', ""],
    ['<img srcset="data:image/png;base64,QQ== 1x, missing.png 2x">', ""],
    ['<svg><use href="sprite.svg#shape"/></svg>', ""],
    ["", '<script src="https://cdn.example/lib.js"></script>'],
    ["", '<style>@import "theme.css";</style>'],
    [
      "",
      "<style>div { background: u\\72l(https://example.com/image); }</style>",
    ],
    ["", '<style>div { background: image-set("image.png" 1x); }</style>'],
    ['<iframe srcdoc="content"></iframe>', ""],
    ["", '<meta http-equiv="refresh" content="1;url=https://example.com">'],
  ])
    assert.throws(
      () => validateHtmlBytes(document(body!, head!)),
      /HTML_/,
      `${body} ${head}`,
    );
});

test("embedded images, local anchors and data srcset survive unchanged", () => {
  const bytes = document(
    '<img srcset="data:image/png;base64,QQ== 1x, data:image/png;base64,Qg== 2x"><a href="#end">End</a><p id="end">done</p>',
    '<style>div{background:url("data:image/png;base64,QQ==")}</style>',
  );
  const copy = Buffer.from(bytes);
  validateHtmlBytes(bytes);
  assert.deepEqual(bytes, copy);
});

test("incomplete, invalid UTF-8, and malformed capability metadata fail", () => {
  assert.throws(() => validateHtmlBytes(Buffer.from("<html><body>partial")));
  assert.throws(() => validateHtmlBytes(Buffer.from([0xff])));
  assert.throws(() =>
    validateHtmlBytes(
      document("", '<meta name="sourceweft:artifact" content="{}">'),
    ),
  );
});

test("HTML edits require the caller's pre-edit version", () => {
  const input = {
    artifactType: "html",
    title: "Page",
    source: { kind: "sandbox_path", path: "/workspace/page.html" },
    republishArtifactId: "a1",
  };
  assert.equal(PublishArtifactInputSchema.safeParse(input).success, false);
  assert.ok(
    PublishArtifactInputSchema.safeParse({ ...input, expectedVersionNo: 2 })
      .success,
  );
});

test("publisher stores exactly the checked bytes and rejects changed QA output", async () => {
  const bytes = document("<h1>Final</h1>");
  const digest = validateHtmlBytes(bytes).contentDigest;
  let published = 0;
  const services = {
    artifacts: {
      publishArtifact: async ({ spec }: any) => {
        published++;
        assert.equal(spec.attachments[0].bytes, bytes);
        return { artifactId: "a1", versionId: "v1", reused: false };
      },
    },
  };
  const source = {
    kind: "sandbox_path" as const,
    path: "/workspace/page.html",
  };
  const adapters = [
    {
      kind: "sandbox_path" as const,
      canRead: () => true,
      read: async () => ({ bytes, path: source.path, source }),
    },
  ];
  const args = {
    context: { teamId: "t", workspaceId: "w", threadId: "th", userId: "u" },
    services,
    sourceAdapters: adapters,
    input: {
      artifactType: "html" as const,
      title: "Page",
      source,
      expectedContentDigest: digest,
    },
  };
  const result = await publishArtifact(args);
  assert.equal(result.artifactVersionId, "v1");
  await assert.rejects(
    publishArtifact({
      ...args,
      input: {
        ...args.input,
        expectedContentDigest: `sha256:${"0".repeat(64)}`,
      },
    }),
    /ARTIFACT_CONTENT_CHANGED/,
  );
  assert.equal(published, 1);
});
