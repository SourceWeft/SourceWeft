import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  GITHUB_REQUEST_TIMEOUTS,
  GitHubArchiveError,
  githubFetch,
  normalizeGitHubSource,
  assertCommitOnDefaultBranch,
  resolveCommit,
} from "./github";

/** A `fetch` that never answers, but honours its abort signal like the real one. */
function stalledFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      }),
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const source = normalizeGitHubSource("acme/skills");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("githubFetch deadline", () => {
  test("the deadlines are bounded constants", () => {
    assert.equal(GITHUB_REQUEST_TIMEOUTS.metadataMs, 30_000);
    assert.equal(GITHUB_REQUEST_TIMEOUTS.archiveMs, 120_000);
  });

  test("a stalled response becomes ARCHIVE_TIMEOUT instead of hanging", async () => {
    const fetchMock = stalledFetch();
    vi.stubGlobal("fetch", fetchMock);
    await assert.rejects(
      githubFetch("https://api.github.com/x", {}, { timeoutMs: 20 }),
      (error: unknown) =>
        error instanceof GitHubArchiveError && error.code === "ARCHIVE_TIMEOUT",
    );
    // The budget is spent; a timeout is not retried.
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  test("every request carries an abort signal", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({}),
    );
    vi.stubGlobal("fetch", fetchMock);
    await githubFetch("https://api.github.com/x", {});
    assert.ok(fetchMock.mock.calls[0]?.[1]?.signal instanceof AbortSignal);
  });

  test("a caller's own cancellation is not reported as a timeout", async () => {
    vi.stubGlobal("fetch", stalledFetch());
    const controller = new AbortController();
    const pending = githubFetch(
      "https://api.github.com/x",
      {},
      { timeoutMs: 5_000, signal: controller.signal },
    );
    controller.abort(new Error("caller went away"));
    await assert.rejects(
      pending,
      (error: unknown) =>
        !(error instanceof GitHubArchiveError) &&
        error instanceof Error &&
        error.message === "caller went away",
    );
  });
});

describe("resolveCommit", () => {
  test("returns the committer date from the same response as the sha", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          sha: "a".repeat(40),
          commit: { committer: { date: "2026-02-01T10:00:00Z" } },
        }),
      ),
    );
    assert.deepEqual(await resolveCommit(source, "main"), {
      sha: "a".repeat(40),
      committedAt: "2026-02-01T10:00:00.000Z",
    });
  });

  test("drops a missing or malformed date rather than storing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          sha: "a".repeat(40),
          commit: { committer: { date: "not a date" } },
        }),
      ),
    );
    assert.deepEqual(await resolveCommit(source, "main"), {
      sha: "a".repeat(40),
    });
  });

  test("a sha GitHub cannot find is unpinnable, never trusted as-is", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)),
    );
    // An unread sha is an unverified one: it could be anything, including a
    // commit that only exists in a fork.
    assert.equal(await resolveCommit(source, "b".repeat(40)), undefined);
    assert.equal(await resolveCommit(source, "main"), undefined);
  });

  test("a stalled lookup of a branch surfaces as a timeout, not as unpinnable", async () => {
    vi.stubGlobal("fetch", stalledFetch());
    await assert.rejects(
      resolveCommit(source, "main", { timeoutMs: 20 }),
      (error: unknown) =>
        error instanceof GitHubArchiveError && error.code === "ARCHIVE_TIMEOUT",
    );
    // A full sha is no exception: without GitHub's word on it, it is not pinned.
    await assert.rejects(
      resolveCommit(source, "c".repeat(40), { timeoutMs: 20 }),
      (error: unknown) =>
        error instanceof GitHubArchiveError && error.code === "ARCHIVE_TIMEOUT",
    );
  });

  test("a 5xx while resolving is a failure to retry, not an unpinnable ref", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "boom" }, 502)),
    );
    await assert.rejects(resolveCommit(source, "d".repeat(40)), /failed 502/);
  });
});

describe("assertCommitOnDefaultBranch", () => {
  const compare = (status: string | null, httpStatus = 200) =>
    vi.fn(async (url: string) => {
      assert.match(url, /\/compare\/[0-9a-f]{40}\.\.\.main\?per_page=1$/);
      return httpStatus === 200
        ? jsonResponse({ status })
        : jsonResponse({ message: "x" }, httpStatus);
    });
  const sha = "e".repeat(40);

  test("a commit in the default branch's history is accepted", async () => {
    for (const status of ["ahead", "identical"]) {
      vi.stubGlobal("fetch", compare(status));
      await assertCommitOnDefaultBranch(source, sha, "main");
    }
  });

  test("a fork's commit — or any not on the default branch — is refused", async () => {
    for (const [status, httpStatus] of [
      ["behind", 200],
      ["diverged", 200],
      [null, 404],
    ] as const) {
      vi.stubGlobal("fetch", compare(status, httpStatus));
      await assert.rejects(
        assertCommitOnDefaultBranch(source, sha, "main"),
        (error: unknown) =>
          error instanceof GitHubArchiveError &&
          error.code === "ARCHIVE_NOT_IN_REPOSITORY",
      );
    }
  });
});
