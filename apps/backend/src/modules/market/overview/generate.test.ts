import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  buildMcpOverviewOutputSchema,
  buildMcpOverviewPrompt,
} from "./prompt";
import { genesis402Evidence, genesis402ModelAnswer } from "./test-answer";
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

  test("gets no overview when nothing in its input can be cited as evidence", async () => {
    // A README of code alone, a short description and no variables: nothing
    // is numbered, so there is no ID for the schema to list.
    const codeOnly = "# mcp\n\n```bash\nnpx -y widgets-mcp\n```\n";
    mocks.findRow.mockResolvedValue(
      row({
        readmeMd: codeOnly,
        readmeSha256: createHash("sha256").update(codeOnly).digest("hex"),
        provenanceJson: {},
        manifestJson: {
          ...federatedManifest(genesis402RegistryServer),
          description: "Widgets.",
        },
      }),
    );
    const subject = await loadMcpOverviewSubject("mcpv-genesis");
    assert.equal(subject!.input?.readme?.segments.length, 1);
    assert.equal(mcpOverviewSkipReason(subject!), "no-content");
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
    // Stored as before: the primary, then the secondaries, each with the
    // text of the passage it cites.
    assert.deepEqual(parsed.classification, {
      status: "ready",
      categories: [
        { slug: "finance", evidence: genesis402Evidence.finance.stored },
        {
          slug: "web-search-scraping",
          evidence: genesis402Evidence.webExtraction.stored,
        },
      ],
      rationale: genesis402ModelAnswer().classification.rationale,
    });
    // Resolved against the passages of the prompt it is given.
    assert.throws(
      () =>
        mcpOverviewAdapter.parseOutput(genesis402ModelAnswer(), subject, {
          ...prompt,
          passages: prompt.passages.filter(
            (passage) => passage.id !== genesis402Evidence.finance.id,
          ),
        }),
      (error: unknown) =>
        error instanceof McpOverviewOutputError &&
        error.reason === "evidence_unknown_passage",
    );
  });

  test("builds each version's prompt with its own schema", async () => {
    mocks.findRow.mockResolvedValue(row());
    const subject = (await loadMcpOverviewSubject("mcpv-genesis"))!;
    const prompt = mcpOverviewAdapter.buildPrompt(subject);
    assert.deepEqual(prompt, buildMcpOverviewPrompt(subject.input!));
    assert.deepEqual(
      prompt.outputSchema,
      buildMcpOverviewOutputSchema(
        prompt.passages.map((passage) => passage.id),
      ),
    );
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
    const complete = vi.fn(async (_input: unknown) => ({
      model: "deepseek/deepseek-v4.1-flash",
      providerModel: "deepseek/deepseek-v4.1-flash",
      structuredOutput: genesis402ModelAnswer(),
      raw: { content: "" },
    }));
    mocks.withSystemModel.mockImplementation(
      async (
        _context: unknown,
        run: (chat: { complete: typeof complete }) => Promise<unknown>,
      ) => run({ complete }),
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
    // The schema sent is this version's: evidence is one of its passage IDs,
    // not the adapter's static shape.
    const prompt = buildMcpOverviewPrompt(
      buildMcpOverviewInput(genesis402Source()),
    );
    const request = complete.mock.calls[0]![0] as {
      structuredOutput: { name: string; schema: unknown };
    };
    assert.equal(request.structuredOutput.name, MCP_OVERVIEW_OUTPUT_NAME);
    assert.deepEqual(request.structuredOutput.schema, prompt.outputSchema);
    assert.notDeepEqual(
      request.structuredOutput.schema,
      MCP_OVERVIEW_OUTPUT_JSON_SCHEMA,
    );
    assert.match(
      JSON.stringify(request.structuredOutput.schema),
      new RegExp(`"enum":\\["D1","R1",.*"${genesis402Evidence.finance.id}"`),
    );
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

  test("an answer citing a passage the prompt did not number is refused and logged, for the job to retry", async () => {
    mocks.findRow.mockResolvedValue(row());
    mocks.store.claim.mockResolvedValue({
      requestId: "r1",
      status: "running",
      force: false,
    });
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const answer = genesis402ModelAnswer();
    answer.classification.primary.evidence = "R999";
    answer.en.summary = "A summary that is nowhere in the log.";
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
        assert.equal(error.reason, "evidence_unknown_passage");
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
      error: 'Evidence for finance is not a numbered passage: "R999"',
      reason: "evidence_unknown_passage",
    });
    assert.doesNotMatch(
      JSON.stringify(rejected[0]),
      /nowhere in the log|pay-per-call/,
    );
  });
});
