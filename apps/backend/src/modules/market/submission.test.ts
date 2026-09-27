import assert from "node:assert/strict";
import { test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  getExisting: vi.fn(),
  upsert: vi.fn(),
  scan: vi.fn(),
  writeReadme: vi.fn(),
}));

vi.mock("./parse-repository", () => ({ parseMcpRepository: mocks.parse }));
vi.mock("./ingest/repository", () => ({
  getMarketItemForSubmission: mocks.getExisting,
  upsertMarketMcp: mocks.upsert,
}));
vi.mock("./scan", () => ({ scanMcpSubmission: mocks.scan }));
vi.mock("./readme/readme-repository", () => ({
  writeMcpReadmeColumns: mocks.writeReadme,
}));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { createHash } from "node:crypto";
import { mcpServerVersionId } from "./ingest/plan";
import { MarketSubmissionError, submitMcpFromGitHub } from "./submission";

function primeParse(identifier: string, cleanScan = true) {
  mocks.parse.mockResolvedValue({
    manifest: { identifier, version: "1.0.0" },
    report: { github: { owner: "acme" } },
  });
  mocks.scan.mockReturnValue({
    reviewRequired: !cleanScan,
    flags: cleanScan ? [] : ["command:sudo"],
  });
  mocks.upsert.mockResolvedValue("item-id");
}

test("a clean submission for a new identifier auto-publishes", async () => {
  vi.clearAllMocks();
  primeParse("io.github.acme/new");
  mocks.getExisting.mockResolvedValue(null);

  const result = await submitMcpFromGitHub({
    repoUrl: "https://github.com/acme/new",
    userId: "me",
  });

  assert.equal(result.status, "published");
  assert.equal(mocks.upsert.mock.calls[0]?.[0]?.status, "published");
  assert.equal(mocks.upsert.mock.calls[0]?.[0]?.origin, "submitted");
});

test("a submission cannot overwrite a federated (upstream) entry", async () => {
  vi.clearAllMocks();
  primeParse("io.github.modelcontextprotocol/everything");
  mocks.getExisting.mockResolvedValue({
    hasUpstream: true,
    status: "published",
    submittedBy: null,
  });

  await assert.rejects(
    () =>
      submitMcpFromGitHub({
        repoUrl: "https://github.com/attacker/evil",
        userId: "me",
      }),
    (error) =>
      error instanceof MarketSubmissionError &&
      error.code === "MARKET_SUBMISSION_CONFLICT",
  );
  assert.equal(mocks.upsert.mock.calls.length, 0);
});

test("an identifier under review stays in review on a clean re-submit", async () => {
  vi.clearAllMocks();
  primeParse("io.github.acme/pending"); // clean scan
  mocks.getExisting.mockResolvedValue({
    hasUpstream: false,
    status: "reviewing",
    submittedBy: "me",
  });

  const result = await submitMcpFromGitHub({
    repoUrl: "https://github.com/acme/pending",
    userId: "me",
  });

  // Sticky: cannot auto-publish by dropping the risky line.
  assert.equal(result.status, "reviewing");
  assert.equal(mocks.upsert.mock.calls[0]?.[0]?.status, "reviewing");
});

test("a submission cannot hijack another submitter's published listing", async () => {
  vi.clearAllMocks();
  primeParse("io.github.acme/taken");
  mocks.getExisting.mockResolvedValue({
    hasUpstream: false,
    status: "published",
    submittedBy: "someone-else",
  });

  await assert.rejects(
    () =>
      submitMcpFromGitHub({
        repoUrl: "https://github.com/attacker/taken",
        userId: "me",
      }),
    (error) => error instanceof MarketSubmissionError,
  );
  assert.equal(mocks.upsert.mock.calls.length, 0);
});

test("a submission cannot poison another submitter's IN-REVIEW item", async () => {
  vi.clearAllMocks();
  primeParse("io.github.acme/pending");
  // Victim's flagged submission is sitting in review, owned by someone else.
  mocks.getExisting.mockResolvedValue({
    hasUpstream: false,
    status: "reviewing",
    submittedBy: "victim",
  });

  await assert.rejects(
    () =>
      submitMcpFromGitHub({
        repoUrl: "https://github.com/attacker/pending",
        userId: "attacker",
      }),
    (error) =>
      error instanceof MarketSubmissionError &&
      error.code === "MARKET_SUBMISSION_CONFLICT",
  );
  assert.equal(mocks.upsert.mock.calls.length, 0);
});

const COMMIT = "c0ffee".padEnd(40, "0");

function primeParseWithReadme(readme?: { path: string; bytes: Buffer }) {
  mocks.parse.mockResolvedValue({
    manifest: { identifier: "io.github.acme/weather", version: "1.2.0" },
    report: {
      github: {
        owner: "acme",
        repo: "tools",
        ref: COMMIT,
        commitSha: COMMIT,
        repoUrl: "https://github.com/acme/tools",
        sourceUrl: "https://github.com/acme/tools/tree/main/servers/weather",
        subpath: "servers/weather",
      },
    },
    ...(readme ? { readme } : {}),
  });
  mocks.scan.mockReturnValue({ reviewRequired: false, flags: [] });
  mocks.upsert.mockResolvedValue("item-id");
  mocks.getExisting.mockResolvedValue(null);
}

test("a submission stores the README its parse read, pinned to the parsed commit", async () => {
  vi.clearAllMocks();
  const bytes = Buffer.from("# Weather\n\nForecasts.\n");
  primeParseWithReadme({ path: "servers/weather/README.md", bytes });

  const before = Date.now();
  await submitMcpFromGitHub({
    repoUrl: "https://github.com/acme/tools/tree/main/servers/weather",
    userId: "me",
  });

  // Where the server lives, for the fetch job to read it again later.
  assert.deepEqual(
    mocks.upsert.mock.calls[0]?.[0]?.provenanceJson?.repository,
    {
      url: "https://github.com/acme/tools",
      subfolder: "servers/weather",
    },
  );
  assert.equal(mocks.writeReadme.mock.calls.length, 1);
  const [versionId, columns] = mocks.writeReadme.mock.calls[0]!;
  assert.equal(
    versionId,
    mcpServerVersionId("io.github.acme/weather", "1.2.0"),
  );
  assert.equal(columns.readmeStatus, "ok");
  assert.equal(columns.readmeMd, "# Weather\n\nForecasts.\n");
  assert.equal(columns.readmePath, "servers/weather/README.md");
  assert.equal(columns.readmeRef, COMMIT);
  assert.equal(
    columns.readmeSha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const nextIn = columns.readmeNextFetchAt.getTime() - before;
  const week = 7 * 24 * 60 * 60 * 1000;
  assert.ok(nextIn >= week - 1000 && nextIn <= week + 60_000, String(nextIn));
});

test("an oversized or non-Markdown README gets its status; none leaves the version pending", async () => {
  vi.clearAllMocks();
  primeParseWithReadme({
    path: "servers/weather/README.md",
    bytes: Buffer.alloc(512 * 1024 + 1, 0x61),
  });
  await submitMcpFromGitHub({
    repoUrl: "https://github.com/acme/tools",
    userId: "me",
  });
  assert.equal(mocks.writeReadme.mock.calls[0]?.[1]?.readmeStatus, "too_large");
  assert.equal(mocks.writeReadme.mock.calls[0]?.[1]?.readmeMd, null);

  vi.clearAllMocks();
  primeParseWithReadme({
    path: "README.rst",
    bytes: Buffer.from("Weather\n==="),
  });
  await submitMcpFromGitHub({
    repoUrl: "https://github.com/acme/tools",
    userId: "me",
  });
  assert.equal(mocks.writeReadme.mock.calls[0]?.[1]?.readmeStatus, "not_found");

  vi.clearAllMocks();
  primeParseWithReadme();
  await submitMcpFromGitHub({
    repoUrl: "https://github.com/acme/tools",
    userId: "me",
  });
  assert.equal(mocks.upsert.mock.calls.length, 1);
  // Nothing written: the version keeps its `pending` default for the fetch job.
  assert.equal(mocks.writeReadme.mock.calls.length, 0);
});
