import assert from "node:assert/strict";
import { test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  getExisting: vi.fn(),
  upsert: vi.fn(),
  scan: vi.fn(),
}));

vi.mock("./parse-repository", () => ({ parseMcpRepository: mocks.parse }));
vi.mock("./ingest/repository", () => ({
  getMarketItemForSubmission: mocks.getExisting,
  upsertMarketMcp: mocks.upsert,
}));
vi.mock("./scan", () => ({ scanMcpSubmission: mocks.scan }));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

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
