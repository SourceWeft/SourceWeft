// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { flush, mountWithIntl, unmountAll } from "@/test/react";
import type { ThreadSearchResult } from "@sourceweft/contracts";
import { useChatSearch, type ChatSearchState } from "./use-chat-search";

function result(id: string): ThreadSearchResult {
  return {
    thread: {
      id,
      teamId: "org-1",
      workspaceId: "ws-1",
      title: id,
      modelSettings: {
        llmModelAlias: null,
        imageModelAlias: null,
        visionModelAlias: null,
      },
      sourceCount: 0,
      visibility: "private",
      parentThreadId: null,
      personaId: null,
      origin: "user",
      createdBy: "user-1",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      lastMessageAt: null,
      chatPreferences: {
        thinking: { mode: "auto", effort: "medium" },
        webAccess: true,
        composerOptions: {},
      },
    } as ThreadSearchResult["thread"],
    archived: false,
    match: { kind: "title", snippet: id },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let state: ChatSearchState;
let setQuery: (query: string) => void;

async function mountSearch(
  search: (q: string) => Promise<{ items: ThreadSearchResult[] }>,
) {
  const React = await import("react");
  function Harness() {
    const [query, set] = React.useState("");
    setQuery = set;
    state = useChatSearch(query, search, 0);
    return null;
  }
  await mountWithIntl(<Harness />);
}

async function type(query: string) {
  await act(async () => {
    setQuery(query);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

afterEach(unmountAll);

test("no query means no search and the list stays", async () => {
  const search = vi.fn();
  await mountSearch(search);

  expect(state.active).toBe(false);
  expect(state.loading).toBe(false);
  expect(search).not.toHaveBeenCalled();
});

test("ignores stale search responses", async () => {
  const first = deferred<{ items: ThreadSearchResult[] }>();
  const second = deferred<{ items: ThreadSearchResult[] }>();
  const search = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  await mountSearch(search);

  await type("bud");
  await type("budget");
  expect(search).toHaveBeenNthCalledWith(1, "bud");
  expect(search).toHaveBeenNthCalledWith(2, "budget");
  expect(state.loading).toBe(true);

  await act(async () => {
    second.resolve({ items: [result("new")] });
    await flush(2);
  });
  await act(async () => {
    first.resolve({ items: [result("old")] });
    await flush(2);
  });

  expect(state.loading).toBe(false);
  expect(state.results.map((item) => item.thread.id)).toEqual(["new"]);
});

test("a failed search is reported and a deleted chat leaves the results", async () => {
  const search = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ items: [result("a"), result("b")] });
  await mountSearch(search);

  await type("x");
  await act(async () => flush(2));
  expect(state.failed).toBe(true);
  expect(state.results).toEqual([]);

  await type("y");
  await act(async () => flush(2));
  expect(state.failed).toBe(false);
  await act(async () => state.removeResult("a"));
  expect(state.results.map((item) => item.thread.id)).toEqual(["b"]);
});
