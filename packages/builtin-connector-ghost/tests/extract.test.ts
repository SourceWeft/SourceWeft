import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorItemSkipError,
  isConnectorExtractedFile,
  type ConnectorExtractedContent,
  type ConnectorExtractedText,
} from "@sourceweft/contracts";
import { createGhostClient, type GhostClient } from "../src/client";
import { GhostError } from "../src/errors";
import { extractGhostItem } from "../src/extract";
import { scanSite } from "../src/scan";
import {
  createFakeGhost,
  DEFAULT_KEY,
  hexId,
  sampleState,
  type FakeGhost,
} from "./helpers/fake-ghost";

const SITE = "https://site.example";
const HOST = "site.example";

type Harness = { fake: FakeGhost; client: GhostClient };

function harness(
  state: ReturnType<typeof sampleState> = sampleState(),
): Harness {
  const fake = createFakeGhost({ siteBase: SITE, key: DEFAULT_KEY, ...state });
  const client = createGhostClient({
    fetch: fake.fetch,
    siteBase: SITE,
    key: DEFAULT_KEY,
    sleep: async () => undefined,
    limits: { minRequestGapMs: 0 },
  });
  return { fake, client };
}

async function extract(
  client: GhostClient,
  externalId: string,
  options: { maxChars?: number; signal?: AbortSignal } = {},
): Promise<ConnectorExtractedText> {
  const result: ConnectorExtractedContent = await extractGhostItem({
    client,
    externalId,
    siteHost: HOST,
    ...options,
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

async function failure(promise: Promise<unknown>): Promise<GhostError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GhostError, String(error));
    return error;
  }
  assert.fail("expected a GhostError");
}

async function scannedHash(
  client: GhostClient,
  externalId: string,
): Promise<string | undefined> {
  const page = await scanSite({ client, items: [], siteHost: HOST });
  return (
    page.items.find((i) => i.externalId === externalId)?.contentHash ??
    undefined
  );
}

const POST = `ghost:post:${hexId(1)}`;
const PAGE = `ghost:page:${hexId(3)}`;
const MEMBERS = `ghost:post:${hexId(4)}`;

test("a post extracts to Markdown with the heading, metadata and body", async () => {
  const { client } = harness();
  const result = await extract(client, POST);
  assert.equal(result.contentText, result.markdown);
  const markdown = result.markdown ?? "";
  assert.match(markdown, /^# First\n/);
  assert.match(markdown, /- Type: Post/);
  assert.match(markdown, /- Tags: News/);
  assert.match(markdown, /- Authors: Ada/);
  assert.match(markdown, /- URL: https:\/\/site\.example\//);
  assert.match(markdown, new RegExp(`Body ${hexId(1)}`));
  assert.equal(result.item.externalId, POST);
  assert.equal(result.item.title, "First");
  assert.equal(result.item.mimeType, "text/markdown");
  assert.equal(result.item.metadata.ghostType, "post");
  assert.equal(result.item.metadata.siteHost, HOST);
});

test("a page extracts as a page", async () => {
  const { client } = harness();
  const result = await extract(client, PAGE);
  assert.match(result.markdown ?? "", /^# About\n/);
  assert.match(result.markdown ?? "", /- Type: Page/);
  assert.equal(result.item.metadata.ghostType, "page");
});

test("the route comes from the external id", async () => {
  const { fake, client } = harness();
  await extract(client, PAGE);
  assert.ok(fake.requests.some((r) => r.path.endsWith(`/pages/${hexId(3)}/`)));
  assert.ok(!fake.requests.some((r) => r.path.includes("/posts/")));
});

test("maxChars bounds the Markdown", async () => {
  const state = sampleState();
  state.items[0] = {
    ...state.items[0]!,
    html: `<p>${"word ".repeat(500)}</p>`,
  };
  const { client } = harness(state);
  const result = await extract(client, POST, { maxChars: 300 });
  assert.ok((result.markdown ?? "").length <= 300);
  assert.match(result.markdown ?? "", /\[Content truncated\]$/);
});

test("the extract hash equals the scan hash for a post and a page", async () => {
  const { client } = harness();
  for (const id of [POST, PAGE, `ghost:post:${hexId(2)}`]) {
    const scanned = await scannedHash(client, id);
    assert.ok(scanned, id);
    const result = await extract(client, id);
    assert.equal(result.item.contentHash, scanned, id);
  }
});

test("a post edited between scan and extract returns the new hash", async () => {
  const { fake, client } = harness();
  const before = await scannedHash(client, POST);
  fake.state.items[0] = {
    ...fake.state.items[0]!,
    html: "<p>Edited body.</p>",
    updated_at: "2026-03-03T00:00:00.000Z",
  };
  const result = await extract(client, POST);
  assert.notEqual(result.item.contentHash, before);
  assert.match(result.markdown ?? "", /Edited body\./);
  assert.equal(result.item.contentHash, await scannedHash(client, POST));
});

test("a renamed tag changes the extract hash as it changes the scan hash", async () => {
  const { fake, client } = harness();
  const before = (await extract(client, POST)).item.contentHash;
  fake.state.tags[0] = { ...fake.state.tags[0]!, name: "Headlines" };
  const after = (await extract(client, POST)).item.contentHash;
  assert.notEqual(before, after);
  assert.equal(after, await scannedHash(client, POST));
});

test("a deleted post is skipped as unreadable", async () => {
  const { client } = harness();
  assert.equal(
    await skipReason(extract(client, `ghost:post:${hexId(99)}`)),
    "unreadable",
  );
});

test("a draft (never served) is skipped as unreadable", async () => {
  const state = sampleState();
  state.items.push({ id: hexId(9), type: "post", status: "draft" });
  const { client } = harness(state);
  assert.equal(
    await skipReason(extract(client, `ghost:post:${hexId(9)}`)),
    "unreadable",
  );
});

test("a members-only post is skipped as unreadable and its teaser is never rendered", async () => {
  const state = sampleState();
  state.items[3] = { ...state.items[3]!, teaser: "<p>SECRET-TEASER</p>" };
  const { client } = harness(state);
  assert.equal(await skipReason(extract(client, MEMBERS)), "unreadable");
});

test("a post id used as a page is skipped (the route follows the id)", async () => {
  const { client } = harness();
  assert.equal(
    await skipReason(extract(client, `ghost:page:${hexId(1)}`)),
    "unreadable",
  );
});

test("a bad external id is CONFIG_INVALID and makes no request", async () => {
  const { fake, client } = harness();
  for (const bad of [
    "",
    "ghost:post:1",
    `ghost:tag:${hexId(1)}`,
    `ghost:post:${hexId(0xab).toUpperCase()}`,
    `ghost:post:${hexId(1)}0`,
    ` ghost:post:${hexId(1)}`,
    `ghost:post:${hexId(1)}\n`,
    `wordpress:post:${hexId(1)}`,
    `ghost:post:${hexId(1)}/../x`,
  ]) {
    assert.equal((await failure(extract(client, bad))).code, "CONFIG_INVALID");
  }
  assert.equal(
    (await failure(extract(client, undefined as unknown as string))).code,
    "CONFIG_INVALID",
  );
  assert.equal(fake.requests.length, 0);
});

test("a site failure other than a 404 aborts the run", async () => {
  const { fake, client } = harness();
  fake.failNext({
    status: 403,
    body: JSON.stringify({
      errors: [{ code: "UNKNOWN_CONTENT_API_KEY", type: "UnauthorizedError" }],
    }),
  });
  assert.equal((await failure(extract(client, POST))).code, "BAD_CREDENTIALS");
});

test("an aborted signal stops before any request", async () => {
  const { fake, client } = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(extract(client, POST, { signal: controller.signal }));
  assert.equal(fake.requests.length, 0);
});

test("the key appears in no error and no result", async () => {
  const { fake, client } = harness();
  const result = await extract(client, POST);
  assert.equal(JSON.stringify(result).includes(DEFAULT_KEY), false);
  const errors: unknown[] = [];
  fake.failNext({ status: 500, body: `oops ${DEFAULT_KEY}` }, 10);
  try {
    await extract(client, POST);
  } catch (error) {
    errors.push(error);
  }
  try {
    await extract(client, "bad");
  } catch (error) {
    errors.push(error);
  }
  assert.equal(errors.length, 2);
  for (const error of errors) {
    const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
    assert.equal(text.includes(DEFAULT_KEY), false);
  }
});
