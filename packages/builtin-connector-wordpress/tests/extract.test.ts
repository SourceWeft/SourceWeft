import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorItemSkipError,
  isConnectorExtractedFile,
  type ConnectorExtractedContent,
  type ConnectorExtractedText,
} from "@sourceweft/contracts";
import { createWordPressClient, type WordPressClient } from "../src/client";
import { WordPressError } from "../src/errors";
import { extractWordPressItem } from "../src/extract";
import { scanSite } from "../src/scan";
import {
  createFakeWordPress,
  type FakeWordPress,
  type FakeWordPressOptions,
} from "./helpers/fake-wordpress";

const SITE = "https://site.example";
const HOST = "site.example";
const CREDENTIAL = { username: "wpuser", secret: "app-pass-abcdef" };
const AUTH = `Basic ${Buffer.from(`${CREDENTIAL.username}:${CREDENTIAL.secret}`, "utf8").toString("base64")}`;

type Harness = { fake: FakeWordPress; client: WordPressClient };

function harness(
  options: { fake?: Partial<FakeWordPressOptions>; login?: boolean } = {},
): Harness {
  const fake = createFakeWordPress({
    siteBase: SITE,
    root: "pretty",
    credential: CREDENTIAL,
    categories: [
      { id: 10, name: "Tech", parent: 0 },
      { id: 11, name: "Web", parent: 10 },
    ],
    tags: [
      { id: 20, name: "News" },
      { id: 21, name: "Tips" },
    ],
    users: [{ id: 5, name: "Ann" }],
    posts: [
      {
        id: 1,
        title: "Hello World",
        content: "<p>Body of the post.</p>",
        categories: [10, 11],
        tags: [20, 21],
        author: 5,
        modified_gmt: "2026-02-03T04:05:06",
      },
      {
        id: 2,
        type: "page",
        title: "About",
        content: "<p>About us.</p>",
        author: 5,
      },
    ],
    ...options.fake,
  });
  const client = createWordPressClient({
    fetch: fake.fetch,
    siteBase: SITE,
    allowWpcom: false,
    authorization: options.login ? AUTH : undefined,
    now: () => 0,
    sleep: async () => {},
  });
  return { fake, client };
}

type ExtractOptions = {
  includeUnpublished?: boolean;
  maxChars?: number;
  signal?: AbortSignal;
};

async function extract(
  client: WordPressClient,
  externalId: string,
  options: ExtractOptions = {},
): Promise<ConnectorExtractedText> {
  const result: ConnectorExtractedContent = await extractWordPressItem({
    client,
    externalId,
    includeUnpublished: options.includeUnpublished ?? false,
    siteHost: HOST,
    maxChars: options.maxChars,
    signal: options.signal,
  });
  assert.equal(isConnectorExtractedFile(result), false);
  return result as ConnectorExtractedText;
}

async function skipReason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ConnectorItemSkipError, String(error));
    return error.reason;
  }
  assert.fail("expected a ConnectorItemSkipError");
}

async function failure(promise: Promise<unknown>): Promise<WordPressError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof WordPressError, String(error));
    return error;
  }
  assert.fail("expected a WordPressError");
}

async function scannedHash(
  client: WordPressClient,
  externalId: string,
  includeUnpublished = false,
): Promise<string | undefined> {
  const page = await scanSite({
    client,
    items: [],
    includeUnpublished,
    siteHost: HOST,
  });
  return (
    page.items.find((i) => i.externalId === externalId)?.contentHash ??
    undefined
  );
}

// -------------------------------------------------------------- the shape

test("a post extracts to Markdown with the heading, metadata and body", async () => {
  const { client } = harness();
  const result = await extract(client, "wordpress:post:1");
  assert.equal(result.contentText, result.markdown);
  const markdown = result.markdown ?? "";
  assert.match(markdown, /^# Hello World\n/);
  assert.match(markdown, /- Type: Post/);
  assert.match(markdown, /- Categories: Tech, Web/);
  assert.match(markdown, /- Tags: (News, Tips|Tips, News)/);
  assert.match(markdown, /- Author: Ann/);
  assert.match(markdown, /- Modified: 2026-02-03T04:05:06\.000Z/);
  assert.match(markdown, /- URL: https:\/\/site\.example\/\?p=1/);
  assert.match(markdown, /Body of the post\./);
  assert.doesNotMatch(markdown, /Status:/);
  assert.equal(result.item.externalId, "wordpress:post:1");
  assert.equal(result.item.externalUri, "https://site.example/?p=1");
  assert.equal(result.item.title, "Hello World");
  assert.equal(result.item.mimeType, "text/markdown");
  assert.equal(result.item.metadata.wpId, 1);
  assert.equal(result.item.metadata.wpType, "post");
});

test("a page extracts as a page", async () => {
  const { client } = harness();
  const result = await extract(client, "wordpress:page:2");
  assert.match(result.markdown ?? "", /^# About\n/);
  assert.match(result.markdown ?? "", /- Type: Page/);
  assert.match(result.markdown ?? "", /About us\./);
  assert.equal(result.item.metadata.wpType, "page");
});

test("maxChars bounds the Markdown", async () => {
  const { client } = harness({
    fake: { posts: [{ id: 1, content: `<p>${"word ".repeat(500)}</p>` }] },
  });
  const result = await extract(client, "wordpress:post:1", { maxChars: 300 });
  assert.ok((result.markdown ?? "").length <= 300);
  assert.match(result.markdown ?? "", /\[Content truncated\]$/);
});

// ------------------------------------------------------- hash equals scan

test("the extract hash equals the scan hash for a post and a page", async () => {
  const { client } = harness();
  for (const id of ["wordpress:post:1", "wordpress:page:2"]) {
    const scanned = await scannedHash(client, id);
    assert.ok(scanned);
    const result = await extract(client, id);
    assert.equal(result.item.contentHash, scanned, id);
  }
});

test("a post edited between scan and extract returns the new hash", async () => {
  const { fake, client } = harness();
  const before = await scannedHash(client, "wordpress:post:1");
  fake.setState({
    posts: [
      {
        id: 1,
        title: "Hello World",
        content: "<p>Edited body.</p>",
        categories: [10, 11],
        tags: [20, 21],
        author: 5,
        modified_gmt: "2026-03-03T00:00:00",
      },
    ],
  });
  const result = await extract(client, "wordpress:post:1");
  assert.notEqual(result.item.contentHash, before);
  assert.match(result.markdown ?? "", /Edited body\./);
  assert.equal(
    result.item.contentHash,
    await scannedHash(client, "wordpress:post:1"),
  );
});

test("a renamed category changes the extract hash as it changes the scan hash", async () => {
  const { fake, client } = harness();
  const before = (await extract(client, "wordpress:post:1")).item.contentHash;
  fake.setState({
    categories: [
      { id: 10, name: "Technology", parent: 0 },
      { id: 11, name: "Web", parent: 10 },
    ],
  });
  const after = (await extract(client, "wordpress:post:1")).item.contentHash;
  assert.notEqual(before, after);
  assert.equal(after, await scannedHash(client, "wordpress:post:1"));
});

// --------------------------------------------------- unreadable -> skipped

test("a deleted post is skipped as unreadable", async () => {
  const { client } = harness();
  assert.equal(
    await skipReason(extract(client, "wordpress:post:99")),
    "unreadable",
  );
});

test("a password protected post is skipped and never rendered", async () => {
  const { client } = harness({
    fake: { posts: [{ id: 7, protected: true, title: "Locked" }] },
  });
  assert.equal(
    await skipReason(extract(client, "wordpress:post:7")),
    "unreadable",
  );
});

// ------------------------------------------------------- drafts and status

test("a draft is skipped by the public path (the site answers rest_forbidden)", async () => {
  const { client } = harness({
    fake: { posts: [{ id: 3, status: "draft", title: "Draft" }] },
  });
  assert.equal(
    await skipReason(extract(client, "wordpress:post:3")),
    "unreadable",
  );
});

test("a draft is skipped by the login path without includeUnpublished", async () => {
  const { fake, client } = harness({
    login: true,
    fake: { posts: [{ id: 3, status: "draft", title: "Draft" }] },
  });
  assert.equal(
    await skipReason(extract(client, "wordpress:post:3")),
    "unreadable",
  );
  assert.equal(
    fake.requests.every((r) => !("status" in r.query)),
    true,
  );
});

test("a draft is extracted with includeUnpublished and its status is shown", async () => {
  const { client } = harness({
    login: true,
    fake: { posts: [{ id: 3, status: "draft", title: "Draft" }] },
  });
  const result = await extract(client, "wordpress:post:3", {
    includeUnpublished: true,
  });
  assert.match(result.markdown ?? "", /- Status: draft/);
  assert.equal(result.item.metadata.status, "draft");
  assert.equal(
    result.item.contentHash,
    await scannedHash(client, "wordpress:post:3", true),
  );
});

// ------------------------------------------------ R8b: login-required split

test("a rights-style 401/403 on the single is skipped; a site login wall aborts", async () => {
  for (const code of [
    "rest_forbidden",
    "rest_cannot_view",
    "rest_user_cannot_view",
  ]) {
    const { fake, client } = harness();
    fake.failNext({ status: 403, body: JSON.stringify({ code }) }, 1, (r) =>
      r.path.endsWith("/wp/v2/posts/1"),
    );
    assert.equal(
      await skipReason(extract(client, "wordpress:post:1")),
      "unreadable",
      code,
    );
  }
  for (const code of ["rest_login_required", "rest_not_logged_in"]) {
    const { fake, client } = harness();
    fake.failNext({ status: 401, body: JSON.stringify({ code }) }, 1, (r) =>
      r.path.endsWith("/wp/v2/posts/1"),
    );
    const error = await failure(extract(client, "wordpress:post:1"));
    assert.equal(error.code, "LOGIN_REQUIRED", code);
  }
  // No recognised REST code at all: still a login wall.
  const { fake, client } = harness();
  fake.failNext({ status: 401, body: "{}" }, 1, (r) =>
    r.path.endsWith("/wp/v2/posts/1"),
  );
  assert.equal(
    (await failure(extract(client, "wordpress:post:1"))).code,
    "LOGIN_REQUIRED",
  );
});

test("a login-walled site aborts the extract", async () => {
  const { client } = harness({ fake: { loginRequired: true } });
  assert.equal(
    (await failure(extract(client, "wordpress:post:1"))).code,
    "LOGIN_REQUIRED",
  );
});

test("other failures propagate and never become a skip", async () => {
  const cases: { status: number; code: string }[] = [
    { status: 429, code: "RATE_LIMITED" },
    { status: 500, code: "SITE_UNREACHABLE" },
  ];
  for (const { status, code } of cases) {
    const { fake, client } = harness();
    fake.failNext({ status }, 10, (r) => r.path.endsWith("/wp/v2/posts/1"));
    const error = await failure(extract(client, "wordpress:post:1"));
    assert.ok(
      error.code === code || error.code === "BAD_RESPONSE",
      `${status} -> ${error.code}`,
    );
  }
});

test("a malformed body is BAD_RESPONSE", async () => {
  const { fake, client } = harness();
  fake.failNext({ status: 200, body: JSON.stringify({ id: 1 }) }, 1, (r) =>
    r.path.endsWith("/wp/v2/posts/1"),
  );
  assert.equal(
    (await failure(extract(client, "wordpress:post:1"))).code,
    "BAD_RESPONSE",
  );
});

test("a link under another host is LINK_HOST_MISMATCH", async () => {
  const { client } = harness({
    fake: { posts: [{ id: 1, link: "https://evil.example/?p=1" }] },
  });
  assert.equal(
    (await failure(extract(client, "wordpress:post:1"))).code,
    "LINK_HOST_MISMATCH",
  );
});

// ---------------------------------------------------------- bad externalId

test("a bad externalId is CONFIG_INVALID and makes no request", async () => {
  const bad = [
    "",
    "wordpress:post:0",
    "wordpress:post:01",
    "wordpress:post:12345678901",
    "wordpress:media:1",
    "wordpress:post:1:2",
    "wordpress:post:-1",
    "wordpress:post:1\n",
    "post:1",
    "wordpress:Post:1",
  ];
  for (const externalId of bad) {
    const { fake, client } = harness();
    const error = await failure(extract(client, externalId));
    assert.equal(error.code, "CONFIG_INVALID", JSON.stringify(externalId));
    assert.equal(fake.requests.length, 0);
  }
});

// -------------------------------------------------------------- no secrets

test("no error or result contains the Authorization value or the secret", async () => {
  const { fake, client } = harness({
    login: true,
    fake: {
      posts: [
        { id: 1, title: "Pub" },
        { id: 3, status: "draft", title: "Draft" },
      ],
    },
  });
  const outputs: string[] = [];
  outputs.push(
    JSON.stringify(
      await extract(client, "wordpress:post:3", { includeUnpublished: true }),
    ),
  );
  for (const id of ["wordpress:post:99", "bogus"]) {
    try {
      await extract(client, id);
    } catch (error) {
      outputs.push(
        JSON.stringify({
          name: (error as Error).name,
          message: (error as Error).message,
          stack: (error as Error).stack,
        }),
      );
    }
  }
  fake.failNext(
    { status: 401, body: JSON.stringify({ code: "incorrect_password" }) },
    1,
    (r) => r.path.endsWith("/wp/v2/posts/1"),
  );
  try {
    await extract(client, "wordpress:post:1");
  } catch (error) {
    outputs.push(String((error as Error).message));
  }
  for (const text of outputs) {
    assert.equal(text.includes(AUTH), false);
    assert.equal(text.includes(CREDENTIAL.secret), false);
    assert.equal(
      text.includes(
        Buffer.from(`${CREDENTIAL.username}:${CREDENTIAL.secret}`).toString(
          "base64",
        ),
      ),
      false,
    );
  }
});

test("an aborted signal stops before any request", async () => {
  const { fake, client } = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    extract(client, "wordpress:post:1", { signal: controller.signal }),
  );
  assert.equal(fake.requests.length, 0);
});
