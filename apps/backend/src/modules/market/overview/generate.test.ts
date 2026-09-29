import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import type { McpOverviewSubjectRow } from "./repository";

const mocks = vi.hoisted(() => ({
  findRow: vi.fn(),
  store: {
    read: vi.fn(),
    request: vi.fn(),
    claim: vi.fn(),
    fail: vi.fn(),
    findCached: vi.fn(),
    publish: vi.fn(),
    findInterrupted: vi.fn(),
  },
  withSystemModel: vi.fn(),
}));

vi.mock("./repository", () => ({
  findMcpOverviewSubjectRow: mocks.findRow,
  mcpOverviewStore: mocks.store,
}));
vi.mock(
  "../../../shared/model-gateway/system-client",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../shared/model-gateway/system-client")
    >()),
    withSystemModel: mocks.withSystemModel,
  }),
);

import {
  MCP_OVERVIEW_MAX_OUTPUT_TOKENS,
  generateMcpOverview,
  loadMcpOverviewSubject,
  mcpOverviewAdapter,
  mcpOverviewSkipReason,
} from "./generate";
import { buildMcpOverviewInput } from "./input";
import { logger } from "../../../shared/logger";
import {
  MCP_OVERVIEW_OUTPUT_JSON_SCHEMA,
  MCP_OVERVIEW_OUTPUT_NAME,
  MCP_OVERVIEW_PROMPT_VERSION,
  MCP_OVERVIEW_TAXONOMY_VERSION,
  McpOverviewOutputError,
} from "./prompt";
import { genesis402ModelAnswer } from "./test-answer";
import {
  federatedManifest,
  genesis402RegistryServer,
  genesis402Source,
  readmeFixture,
} from "./test-fixtures";

const readme = readmeFixture("genesis402-mcp-readme.md");

function row(
  overrides: Partial<McpOverviewSubjectRow> = {},
): McpOverviewSubjectRow {
  return {
    versionId: "mcpv-genesis",
    serverId: "mcp-genesis",
    identifier: "io.github.FTHTrading/genesis402-mcp",
    version: "0.2.0",
    eligible: true,
    manifestJson: federatedManifest(genesis402RegistryServer),
    provenanceJson: {
      registryServer: { packages: genesis402RegistryServer.packages },
    },
    readmeStatus: "ok",
    readmeSha256: readme.sha256,
    readmeMd: readme.markdown,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the MCP subject", () => {
  test("is the version with its input, fingerprinted by buildMcpOverviewInput", async () => {
    mocks.findRow.mockResolvedValue(row());
    const subject = await loadMcpOverviewSubject("mcpv-genesis");
    assert.ok(subject);
    const expected = buildMcpOverviewInput(genesis402Source());
    assert.equal(subject.fingerprint, expected.inputSha256);
    assert.equal(subject.input?.inputSha256, expected.inputSha256);
    assert.equal(subject.serverId, "mcp-genesis");
    assert.equal(mcpOverviewSkipReason(subject), null);
  });

  test("is null for a version that does not exist", async () => {
    mocks.findRow.mockResolvedValue(null);
    assert.equal(await loadMcpOverviewSubject("missing"), null);
  });

  test("gets no overview while ineligible, waiting for its README, unreadable or empty", async () => {
    const reasons: Array<[Partial<McpOverviewSubjectRow>, string]> = [
      [{ eligible: false }, "not-eligible"],
      [
        { readmeStatus: "pending", readmeMd: null, readmeSha256: null },
        "readme-pending",
      ],
      [{ manifestJson: { identifier: "broken" } }, "invalid-manifest"],
      [
        {
          readmeStatus: "not_found",
          readmeMd: null,
          readmeSha256: null,
          manifestJson: {
            ...federatedManifest(genesis402RegistryServer),
            description: "Short.",
          },
        },
        "no-content",
      ],
    ];
    for (const [overrides, reason] of reasons) {
      mocks.findRow.mockResolvedValue(row(overrides));
      const subject = await loadMcpOverviewSubject("mcpv-genesis");
      assert.equal(mcpOverviewSkipReason(subject!), reason);
    }
    // No README is no reason to skip when the description says enough.
    mocks.findRow.mockResolvedValue(
      row({ readmeStatus: "not_found", readmeMd: null, readmeSha256: null }),
    );
    const described = await loadMcpOverviewSubject("mcpv-genesis");
    assert.equal(mcpOverviewSkipReason(described!), null);
    assert.equal(described!.input?.readme, null);
  });
});

describe("the MCP adapter", () => {
  test("asks under mcp_market.overview with its output spec", () => {
    assert.equal(mcpOverviewAdapter.purpose, "mcp_market.overview");
    assert.equal(mcpOverviewAdapter.kind, "mcp");
    assert.equal(mcpOverviewAdapter.subjectRef("v1"), "mcp-server-version:v1");
    assert.deepEqual(mcpOverviewAdapter.output, {
      name: MCP_OVERVIEW_OUTPUT_NAME,
      description: mcpOverviewAdapter.output.description,
      schema: MCP_OVERVIEW_OUTPUT_JSON_SCHEMA,
      maxTokens: MCP_OVERVIEW_MAX_OUTPUT_TOKENS,
    });
  });

  test("maps the parsed answer to the shared overview shape and a ready classification", async () => {
    mocks.findRow.mockResolvedValue(row());
    const subject = (await loadMcpOverviewSubject("mcpv-genesis"))!;
    const prompt = mcpOverviewAdapter.buildPrompt(subject);
    const parsed = mcpOverviewAdapter.parseOutput(
      genesis402ModelAnswer(),
      subject,
      prompt,
    );
    assert.deepEqual(Object.keys(parsed.overviews), ["en", "zh-CN", "zh-TW"]);
    assert.match(parsed.overviews.en.cautions ?? "", /GENESIS402_PAYER_KEY/);
    // An empty caution is no caution.
    assert.equal(parsed.overviews["zh-TW"].cautions, null);
    assert.deepEqual(parsed.overviews.en.suggestedCategories, [
      "finance",
      "web-search-scraping",
    ]);
    // Stored as before: the primary, then the secondaries.
    const { primary, secondary, rationale } =
      genesis402ModelAnswer().classification;
    assert.deepEqual(parsed.classification, {
      status: "ready",
      categories: [primary, ...secondary],
      rationale,
    });
  });
});

describe("generating one MCP overview", () => {
  test("claims, asks the system model once and publishes every locale for the version's server", async () => {
    mocks.findRow.mockResolvedValue(row());
    mocks.store.claim.mockResolvedValue({
      requestId: "r1",
      status: "running",
      force: false,
    });
    mocks.store.publish.mockResolvedValue(true);
    mocks.withSystemModel.mockImplementation(
      async (
        _context: unknown,
        run: (chat: { complete: () => Promise<unknown> }) => Promise<unknown>,
      ) =>
        run({
          complete: async () => ({
            model: "deepseek/deepseek-v4.1-flash",
            providerModel: "deepseek/deepseek-v4.1-flash",
            structuredOutput: genesis402ModelAnswer(),
            raw: { content: "" },
          }),
        }),
    );

    const result = await generateMcpOverview({
      versionId: "mcpv-genesis",
      requestId: "r1",
      scopeId: "mcp-overview:job:1",
      modelReady: async () => true,
    });

    assert.deepEqual(result, {
      status: "generated",
      model: "deepseek/deepseek-v4.1-flash",
    });
    assert.equal(mocks.withSystemModel.mock.calls.length, 1);
    assert.deepEqual(mocks.withSystemModel.mock.calls[0]![0], {
      purpose: "mcp_market.overview",
      subjectRef: "mcp-server-version:mcpv-genesis",
      scopeId: "mcp-overview:job:1",
    });
    const published = mocks.store.publish.mock.calls[0]![0];
    assert.equal(published.subject.serverId, "mcp-genesis");
    assert.equal(
      published.subject.fingerprint,
      buildMcpOverviewInput(genesis402Source()).inputSha256,
    );
    assert.equal(published.requestId, "r1");
    assert.deepEqual(Object.keys(published.overviews), [
      "en",
      "zh-CN",
      "zh-TW",
    ]);
    assert.equal(published.classification.status, "ready");
  });

  test("a pending README fails the claimed request without a model call", async () => {
    mocks.findRow.mockResolvedValue(
      row({ readmeStatus: "pending", readmeMd: null, readmeSha256: null }),
    );
    mocks.store.claim.mockResolvedValue({
      requestId: "r1",
      status: "running",
      force: false,
    });
    const result = await generateMcpOverview({
      versionId: "mcpv-genesis",
      requestId: "r1",
      scopeId: "s",
      modelReady: async () => true,
    });
    assert.deepEqual(result, { status: "skipped", reason: "readme-pending" });
    assert.equal(mocks.withSystemModel.mock.calls.length, 0);
    assert.equal(mocks.store.publish.mock.calls.length, 0);
  });

  test("an answer whose evidence is not in the input is refused and logged, for the job to retry", async () => {
    mocks.findRow.mockResolvedValue(row());
    mocks.store.claim.mockResolvedValue({
      requestId: "r1",
      status: "running",
      force: false,
    });
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const answer = genesis402ModelAnswer();
    answer.classification.primary.evidence =
      "A sentence that is nowhere in the README.";
    await assert.rejects(
      generateMcpOverview({
        versionId: "mcpv-genesis",
        requestId: "r1",
        scopeId: "s",
        modelReady: async () => true,
        callModel: async () => ({ output: answer, model: "m" }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof McpOverviewOutputError);
        assert.equal(error.reason, "evidence_not_in_input");
        return true;
      },
    );
    assert.equal(mocks.store.publish.mock.calls.length, 0);
    // One line naming the server and the rule, without the answer's text.
    const rejected = info.mock.calls.filter(
      ([message]) => message === "MCP overview output rejected",
    );
    assert.equal(rejected.length, 1);
    assert.deepEqual(rejected[0]![1], {
      kind: "mcp",
      mcpServerId: "mcp-genesis",
      mcpServerVersionId: "mcpv-genesis",
      identifier: "io.github.FTHTrading/genesis402-mcp",
      readme: "ok",
      truncated: false,
      promptVersion: MCP_OVERVIEW_PROMPT_VERSION,
      taxonomyVersion: MCP_OVERVIEW_TAXONOMY_VERSION,
      model: "m",
      error: "Evidence for finance does not appear in the input",
      reason: "evidence_not_in_input",
    });
    assert.doesNotMatch(
      JSON.stringify(rejected[0]),
      /nowhere in the README|pay-per-call/,
    );
  });
});
