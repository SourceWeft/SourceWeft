import assert from "node:assert/strict";
import { test } from "vitest";
import { importCandidates, type SourceStatusItem } from "./import-candidates";

const noSleep = async () => undefined;

function ports(options: {
  create?: (url: string) => Promise<{ id: string; alreadyExisted?: boolean }>;
  status?: (id: string, call: number) => SourceStatusItem;
}) {
  const calls: string[] = [];
  const polled = new Map<string, number>();
  return {
    calls,
    create:
      options.create ??
      (async (url: string) => {
        calls.push(url);
        return { id: `id:${url}` };
      }),
    statuses: async (ids: string[]) =>
      ids.map((id) => {
        const count = (polled.get(id) ?? 0) + 1;
        polled.set(id, count);
        return (
          options.status?.(id, count) ?? {
            id,
            status: "indexed",
            error: null,
          }
        );
      }),
    sleep: noSleep,
  };
}

test("each page becomes a source and is reported once it is indexed", async () => {
  const p = ports({});
  const outcomes = await importCandidates({
    urls: ["https://a.com/1", "https://b.com/2"],
    ...p,
  });

  assert.deepEqual(
    outcomes.map((item) => [item.url, item.kind]),
    [
      ["https://a.com/1", "indexed"],
      ["https://b.com/2", "indexed"],
    ],
  );
});

test("one page failing does not stop the others, and shows its own reason", async () => {
  const p = ports({
    status: (id) =>
      id.includes("bad")
        ? {
            id,
            status: "failed",
            error: "The page blocked our reader.",
            errorCode: "FETCH_FAILED",
          }
        : { id, status: "indexed", error: null },
  });
  const outcomes = await importCandidates({
    urls: ["https://a.com/1", "https://bad.com/2", "https://c.com/3"],
    ...p,
  });

  assert.deepEqual(
    outcomes.map((item) => item.kind),
    ["indexed", "failed", "indexed"],
  );
  const failed = outcomes.find((item) => item.kind === "failed");
  assert.equal(
    failed?.kind === "failed" && failed.message,
    "The page blocked our reader.",
  );
});

test("a page refused for ingestion pages stops the rest, which are reported as not imported", async () => {
  const sent: string[] = [];
  const p = ports({
    create: async (url) => {
      sent.push(url);
      return { id: `id:${url}` };
    },
    status: (id) =>
      id.includes("b.com")
        ? {
            id,
            status: "failed",
            error: "Ingestion pages limit exceeded",
            errorCode: "PAGES_LIMIT_EXCEEDED",
          }
        : { id, status: "indexed", error: null },
  });

  const outcomes = await importCandidates({
    urls: [
      "https://a.com/1",
      "https://b.com/2",
      "https://c.com/3",
      "https://d.com/4",
    ],
    concurrency: 2,
    ...p,
  });

  assert.deepEqual(sent, ["https://a.com/1", "https://b.com/2"]);
  assert.deepEqual(
    outcomes.map((item) => [item.url, item.kind]),
    [
      ["https://a.com/1", "indexed"],
      ["https://b.com/2", "quota"],
      ["https://c.com/3", "quota"],
      ["https://d.com/4", "quota"],
    ],
  );
});

test("an already-added page is reported as existing without waiting for it", async () => {
  const p = ports({
    create: async (url) => ({ id: `id:${url}`, alreadyExisted: true }),
  });
  const outcomes = await importCandidates({ urls: ["https://a.com/1"], ...p });

  assert.equal(outcomes[0]?.kind, "existing");
});

test("a page rejected when it is added reports why", async () => {
  const p = ports({
    create: async () => {
      throw new Error("YouTube links can't be added as web sources yet.");
    },
  });
  const outcomes = await importCandidates({ urls: ["https://a.com/1"], ...p });

  const first = outcomes[0];
  assert.equal(
    first?.kind === "failed" && first.message,
    "YouTube links can't be added as web sources yet.",
  );
});

test("a page still being read when the wait ends is reported as pending", async () => {
  const p = ports({
    status: (id) => ({ id, status: "processing", error: null }),
  });
  const outcomes = await importCandidates({
    urls: ["https://a.com/1"],
    maxPolls: 3,
    ...p,
  });

  assert.equal(outcomes[0]?.kind, "pending");
});

test("a status poll that fails is retried instead of failing the page", async () => {
  let call = 0;
  const outcomes = await importCandidates({
    urls: ["https://a.com/1"],
    create: async (url) => ({ id: `id:${url}` }),
    statuses: async (ids) => {
      call += 1;
      if (call === 1) throw new Error("network");
      return ids.map((id) => ({ id, status: "indexed", error: null }));
    },
    sleep: noSleep,
  });

  assert.equal(outcomes[0]?.kind, "indexed");
});
