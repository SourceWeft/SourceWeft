import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, vi } from "vitest";
import type { PublicObjectWriter } from "../../../shared/public-storage";
import { createMcpIconStore, mcpIconStorageKey } from "./store";

test("the storage key is the domain and the content hash, with the image's extension", () => {
  const bytes = Buffer.from("icon-bytes");
  const sha = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    mcpIconStorageKey({
      domain: "notion.com",
      bytes,
      contentType: "image/vnd.microsoft.icon",
    }),
    `market/mcp-icons/notion.com/${sha.slice(0, 32)}.ico`,
  );
  // The same bytes write the same object; different bytes a new one.
  assert.notEqual(
    mcpIconStorageKey({
      domain: "notion.com",
      bytes: Buffer.from("other"),
      contentType: "image/png",
    }),
    mcpIconStorageKey({
      domain: "notion.com",
      bytes,
      contentType: "image/png",
    }),
  );
});

test("storing writes the bytes immutably to the public bucket and answers its served URL", async () => {
  const write = vi.fn<PublicObjectWriter>(async (input) => ({
    bucket: "public",
    key: input.key,
    publicUrl: `https://assets.test/${input.key}`,
  }));
  const store = createMcpIconStore(write);
  const bytes = Buffer.alloc(2048, 7);
  const { url } = await store({
    domain: "notion.com",
    bytes,
    contentType: "image/png",
  });
  const key = mcpIconStorageKey({
    domain: "notion.com",
    bytes,
    contentType: "image/png",
  });
  assert.equal(url, `https://assets.test/${key}`);
  assert.equal(write.mock.calls.length, 1);
  const [input] = write.mock.calls[0]!;
  assert.equal(input.key, key);
  assert.equal(input.body, bytes);
  assert.equal(input.contentType, "image/png");
  assert.match(input.cacheControl ?? "", /immutable/);
});

test("only a DNS-shaped domain becomes part of a storage key", () => {
  for (const domain of [
    "",
    "notion",
    "Notion.com",
    "no tion.com",
    "a/b.com",
    "../x.com",
    "-x.com",
  ]) {
    assert.throws(
      () =>
        mcpIconStorageKey({
          domain,
          bytes: Buffer.alloc(1),
          contentType: "image/png",
        }),
      /Not a storable icon domain/,
    );
  }
});
