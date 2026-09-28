import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "vitest";
import { MAX_README_BYTES } from "../../../shared/catalog-readme";
import {
  githubReadmeFileUrls,
  MCP_README_ABSENT_REFRESH_MS,
  MCP_README_ERROR_BACKOFF_MAX_MS,
  MCP_README_MAX_ATTEMPTS,
  MCP_README_REFRESH_MS,
  mcpReadmeErrorBackoffMs,
  mcpReadmeSubfolder,
  mcpReadmeTransition,
  mcpReadmeUnchanged,
  mcpReadmeView,
  submittedReadmeColumns,
  type McpReadmeCurrent,
} from "./readme-state";

const NOW = new Date("2026-09-28T10:00:00Z");
const HOUR = 60 * 60 * 1000;
const COMMIT = "c0ffee".padEnd(40, "0");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const pending = { readmeStatus: "pending" as const, readmeAttempts: 0 };
const ok = { readmeStatus: "ok" as const, readmeAttempts: 0 };

describe("fetch outcome transitions", () => {
  test("ok stores the README and its source and ends a failure streak", () => {
    const columns = mcpReadmeTransition(
      { readmeStatus: "error", readmeAttempts: 3 },
      {
        status: "ok",
        markdown: "# Server",
        path: "mcp/README.md",
        ref: COMMIT,
        sha256: "f".repeat(64),
        byteSize: 8,
      },
      NOW,
    );
    assert.deepEqual(columns, {
      readmeStatus: "ok",
      readmeMd: "# Server",
      readmePath: "mcp/README.md",
      readmeRef: COMMIT,
      readmeSha256: "f".repeat(64),
      readmeFetchedAt: NOW,
      readmeAttempts: 0,
      readmeError: null,
      readmeNextFetchAt: at(MCP_README_REFRESH_MS),
    });
  });

  test("not_modified only moves the fetch times, at the stored status's interval", () => {
    const unchanged = { status: "not_modified" as const };
    assert.deepEqual(mcpReadmeTransition(ok, unchanged, NOW), {
      readmeFetchedAt: NOW,
      readmeAttempts: 0,
      readmeError: null,
      readmeNextFetchAt: at(MCP_README_REFRESH_MS),
    });
    // Kept at the stored status's pace, whatever that status is.
    assert.deepEqual(
      mcpReadmeTransition(
        { readmeStatus: "not_found", readmeAttempts: 1 },
        unchanged,
        NOW,
      ).readmeNextFetchAt,
      at(MCP_README_ABSENT_REFRESH_MS),
    );
  });

  test("not_found clears a stale README, and keeps the file a non-Markdown README names", () => {
    const missing = mcpReadmeTransition(
      ok,
      { status: "not_found", reason: "missing" },
      NOW,
    );
    assert.deepEqual(missing, {
      readmeStatus: "not_found",
      readmeMd: null,
      readmeSha256: null,
      readmeRef: null,
      readmePath: null,
      readmeFetchedAt: NOW,
      readmeAttempts: 0,
      readmeError: null,
      readmeNextFetchAt: at(MCP_README_ABSENT_REFRESH_MS),
    });
    const rst = mcpReadmeTransition(
      ok,
      {
        status: "not_found",
        reason: "not_markdown",
        path: "README.rst",
      },
      NOW,
    );
    assert.equal(rst.readmeStatus, "not_found");
    assert.equal(rst.readmeMd, null);
    assert.equal(rst.readmePath, "README.rst");
  });

  test("too_large points at the file and leaves stored text alone", () => {
    const columns = mcpReadmeTransition(
      ok,
      {
        status: "too_large",
        path: "README.md",
        byteSize: MAX_README_BYTES + 1,
      },
      NOW,
    );
    assert.equal(columns.readmeStatus, "too_large");
    assert.equal(columns.readmePath, "README.md");
    assert.equal(columns.readmeRef, null);
    assert.equal(
      columns.readmeNextFetchAt?.getTime(),
      at(MCP_README_ABSENT_REFRESH_MS).getTime(),
    );
    assert.equal("readmeMd" in columns, false);
    assert.equal("readmeSha256" in columns, false);
  });

  test("unsupported_host clears a stale README and says why", () => {
    const columns = mcpReadmeTransition(
      ok,
      {
        status: "unsupported_host",
        message: "The repository is not on github.com",
      },
      NOW,
    );
    assert.equal(columns.readmeStatus, "unsupported_host");
    assert.equal(columns.readmeMd, null);
    assert.equal(columns.readmePath, null);
    assert.equal(columns.readmeError, "The repository is not on github.com");
    assert.deepEqual(
      columns.readmeNextFetchAt,
      at(MCP_README_ABSENT_REFRESH_MS),
    );
  });

  test("rate_limited counts no attempt and waits for the reset", () => {
    const resetAt = at(20 * 60 * 1000);
    assert.deepEqual(
      mcpReadmeTransition(
        { readmeStatus: "pending", readmeAttempts: 2 },
        { status: "rate_limited", resetAt },
        NOW,
      ),
      { readmeNextFetchAt: resetAt },
    );
  });

  test("an error backs off exponentially and stops after the last attempt", () => {
    const failure = {
      status: "error" as const,
      message: "GitHub GraphQL request failed 502",
    };
    let current: McpReadmeCurrent = { ...pending };
    const delays: Array<number | null> = [];
    for (let attempt = 1; attempt <= MCP_README_MAX_ATTEMPTS; attempt += 1) {
      const columns = mcpReadmeTransition(current, failure, NOW);
      assert.equal(columns.readmeAttempts, attempt);
      assert.equal(columns.readmeError, failure.message);
      delays.push(
        columns.readmeNextFetchAt === null
          ? null
          : columns.readmeNextFetchAt!.getTime() - NOW.getTime(),
      );
      current = {
        readmeStatus: columns.readmeStatus ?? current.readmeStatus,
        readmeAttempts: columns.readmeAttempts!,
      };
    }
    assert.deepEqual(delays, [HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, null]);
    // A version with no answer yet says it failed.
    assert.equal(current.readmeStatus, "error");
  });

  test("an error never takes a README already shown away", () => {
    const columns = mcpReadmeTransition(
      { readmeStatus: "ok", readmeAttempts: 0 },
      { status: "error", message: "timeout" },
      NOW,
    );
    assert.equal("readmeStatus" in columns, false);
    assert.equal("readmeMd" in columns, false);
    assert.equal(columns.readmeAttempts, 1);
    assert.deepEqual(columns.readmeNextFetchAt, at(HOUR));
  });

  test("the backoff is capped at a week", () => {
    assert.equal(mcpReadmeErrorBackoffMs(1), HOUR);
    assert.equal(mcpReadmeErrorBackoffMs(9), MCP_README_ERROR_BACKOFF_MAX_MS);
    assert.equal(mcpReadmeErrorBackoffMs(40), MCP_README_ERROR_BACKOFF_MAX_MS);
  });

  test("a fresh read is unchanged only when it found the same file with the same bytes", () => {
    const read = {
      status: "ok" as const,
      markdown: "# Server",
      path: "README.md",
      ref: COMMIT,
      sha256: "f".repeat(64),
      byteSize: 8,
    };
    const stored = {
      readmeStatus: "ok" as const,
      readmeSha256: "f".repeat(64),
      readmePath: "README.md",
    };
    assert.equal(mcpReadmeUnchanged(stored, read), true);
    assert.equal(
      mcpReadmeUnchanged({ ...stored, readmeSha256: "e".repeat(64) }, read),
      false,
    );
    assert.equal(
      mcpReadmeUnchanged({ ...stored, readmePath: "readme.md" }, read),
      false,
    );
    // Only a README that is shown can be confirmed; anything else is stored.
    assert.equal(
      mcpReadmeUnchanged({ ...stored, readmeStatus: "too_large" }, read),
      false,
    );
    assert.equal(
      mcpReadmeUnchanged(stored, { status: "not_found", reason: "missing" }),
      false,
    );
  });
});

describe("the README a submission stores", () => {
  test("a Markdown README is stored as ok, pinned to the parsed commit", () => {
    const bytes = Buffer.from("# Weather\n\nForecasts.\n");
    assert.deepEqual(
      submittedReadmeColumns(
        { path: "mcp/README.md", bytes, ref: COMMIT },
        NOW,
      ),
      {
        readmeStatus: "ok",
        readmeMd: "# Weather\n\nForecasts.\n",
        readmePath: "mcp/README.md",
        readmeRef: COMMIT,
        readmeSha256: createHash("sha256").update(bytes).digest("hex"),
        readmeFetchedAt: NOW,
        readmeAttempts: 0,
        readmeError: null,
        readmeNextFetchAt: at(MCP_README_REFRESH_MS),
      },
    );
  });

  test("an oversized README is too_large and not stored", () => {
    const columns = submittedReadmeColumns(
      {
        path: "README.md",
        bytes: Buffer.alloc(MAX_README_BYTES + 1, 0x61),
        ref: COMMIT,
      },
      NOW,
    );
    assert.equal(columns?.readmeStatus, "too_large");
    assert.equal(columns?.readmeMd, null);
    assert.equal(columns?.readmePath, "README.md");
    assert.equal(columns?.readmeRef, COMMIT);
    assert.deepEqual(
      columns?.readmeNextFetchAt,
      at(MCP_README_ABSENT_REFRESH_MS),
    );
  });

  test("a README that is not Markdown, or is blank, is not_found", () => {
    for (const [path, text] of [
      ["README.rst", "Weather\n=======\n"],
      ["README", "plain"],
      ["README.md", "  \n\n"],
    ] as const) {
      const columns = submittedReadmeColumns(
        { path, bytes: Buffer.from(text), ref: COMMIT },
        NOW,
      );
      assert.equal(columns?.readmeStatus, "not_found", path);
      assert.equal(columns?.readmeMd, null, path);
      assert.equal(columns?.readmePath, path, path);
    }
  });

  test("bytes that are not UTF-8 text are left for the fetch job", () => {
    assert.equal(
      submittedReadmeColumns(
        {
          path: "README.md",
          bytes: Buffer.from([0xff, 0xfe, 0x00]),
          ref: COMMIT,
        },
        NOW,
      ),
      null,
    );
  });
});

describe("links and the API view", () => {
  test("file URLs are the README's own blob and raw addresses", () => {
    assert.deepEqual(
      githubReadmeFileUrls({
        owner: "FTHTrading",
        repo: "genesis402-agent-kit",
        ref: COMMIT,
        path: "mcp/README.md",
      }),
      {
        blobUrl: `https://github.com/FTHTrading/genesis402-agent-kit/blob/${COMMIT}/mcp/README.md`,
        rawUrl: `https://raw.githubusercontent.com/FTHTrading/genesis402-agent-kit/${COMMIT}/mcp/README.md`,
      },
    );
    assert.equal(
      githubReadmeFileUrls({
        owner: "o",
        repo: "r",
        ref: COMMIT,
        path: "README.md",
      }).blobUrl,
      `https://github.com/o/r/blob/${COMMIT}/README.md`,
    );
  });

  test("markdown is shown only for ok; the source only for a known GitHub file", () => {
    const stored = {
      repoUrl: "https://github.com/prakhar1605/carrerlift-mcp",
      readmeMd: "# CarrerLift",
      readmePath: "README.md",
      readmeRef: COMMIT,
    };
    const shown = mcpReadmeView({ ...stored, readmeStatus: "ok" });
    assert.equal(shown.markdown, "# CarrerLift");
    assert.deepEqual(shown.source, {
      repoUrl: "https://github.com/prakhar1605/carrerlift-mcp",
      ref: COMMIT,
      path: "README.md",
      blobUrl: `https://github.com/prakhar1605/carrerlift-mcp/blob/${COMMIT}/README.md`,
      rawUrl: `https://raw.githubusercontent.com/prakhar1605/carrerlift-mcp/${COMMIT}/README.md`,
    });

    const pendingView = mcpReadmeView({ ...stored, readmeStatus: "pending" });
    assert.equal("markdown" in pendingView, false);

    assert.deepEqual(
      mcpReadmeView({
        ...stored,
        readmeStatus: "unsupported_host",
        repoUrl: "https://gitlab.com/o/r",
      }),
      { status: "unsupported_host", source: null },
    );
    assert.equal(
      mcpReadmeView({ ...stored, readmeStatus: "not_found", readmePath: null })
        .source,
      null,
    );
  });

  test("a README with no pinned commit links to the default branch", () => {
    const view = mcpReadmeView({
      repoUrl: "https://github.com/o/r",
      readmeStatus: "too_large",
      readmeMd: null,
      readmePath: "docs/README.md",
      readmeRef: null,
    });
    assert.equal(view.source?.ref, null);
    assert.equal(
      view.source?.blobUrl,
      "https://github.com/o/r/blob/HEAD/docs/README.md",
    );
  });
});

describe("where the README is asked for", () => {
  test("a known README is read where it was found", () => {
    assert.equal(
      mcpReadmeSubfolder({
        readmePath: "servers/weather/README.md",
        provenanceJson: { repository: { subfolder: "elsewhere" } },
      }),
      "servers/weather",
    );
    assert.equal(
      mcpReadmeSubfolder({ readmePath: "README.md", provenanceJson: {} }),
      "",
    );
  });

  test("before that, the registry's repository.subfolder, else the root", () => {
    assert.equal(
      mcpReadmeSubfolder({
        readmePath: null,
        provenanceJson: {
          repository: { url: "https://github.com/o/r", subfolder: "mcp" },
        },
      }),
      "mcp",
    );
    assert.equal(
      mcpReadmeSubfolder({ readmePath: null, provenanceJson: null }),
      "",
    );
    assert.equal(
      mcpReadmeSubfolder({
        readmePath: null,
        provenanceJson: { repository: "x" },
      }),
      "",
    );
  });
});
