import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildMcpOverviewInput } from "./input";
import {
  mcpOverviewFingerprint,
  mcpOverviewInputOf,
  mcpOverviewSource,
  needsMcpOverviewRetry,
  storedServerInstructions,
  type McpOverviewAttempt,
} from "./source";
import {
  federatedManifest,
  genesis402RegistryServer,
  readmeFixture,
} from "./test-fixtures";

/** A stored genesis402 version as the repository reads it. */
function storedRow(
  overrides: Partial<Parameters<typeof mcpOverviewInputOf>[0]> = {},
) {
  const readme = readmeFixture("genesis402-mcp-readme.md");
  return {
    manifestJson: federatedManifest(genesis402RegistryServer) as unknown,
    provenanceJson: {
      source: "registry.test",
      registryServer: {
        packages: genesis402RegistryServer.packages,
      },
    } as unknown,
    readmeStatus: "ok" as const,
    readmeSha256: readme.sha256,
    readmeMd: readme.markdown,
    ...overrides,
  };
}

describe("the overview source of a stored version", () => {
  test("reads the manifest, the registry description, the fetched README and the kept packages", () => {
    const source = mcpOverviewSource(storedRow());
    assert.ok(source);
    assert.equal(
      source.registryDescription,
      genesis402RegistryServer.description,
    );
    assert.equal(source.readme?.sha256, storedRow().readmeSha256);
    const input = buildMcpOverviewInput(source);
    // The secret's name reaches the prompt facts, from the kept packages.
    assert.deepEqual(
      input.facts.envVars.map((variable) => [variable.name, variable.secret]),
      [
        ["GENESIS402_LIVE", false],
        ["GENESIS402_MAX_USD", false],
        ["GENESIS402_PAYER_KEY", true],
      ],
    );
  });

  // #367 W1 keeps what the server said on `initialize` in the provenance.
  test("reads the server's own instructions from the version's provenance", () => {
    const provenanceJson = {
      ...(storedRow().provenanceJson as Record<string, unknown>),
      selfDescription: {
        source: "endpoint-initialize",
        recordedAt: "2026-10-24T00:00:00.000Z",
        serverInfo: { name: "genesis402", version: "0.2.0" },
        instructions: "Quote first; pay only with GENESIS402_LIVE=1.",
      },
    };
    const source = mcpOverviewSource(storedRow({ provenanceJson }));
    assert.equal(
      source?.instructions,
      "Quote first; pay only with GENESIS402_LIVE=1.",
    );
    assert.equal(
      mcpOverviewInputOf(storedRow({ provenanceJson }))!.instructions,
      "Quote first; pay only with GENESIS402_LIVE=1.",
    );
    // Tolerant of versions synced before the field existed, and of junk.
    assert.equal(mcpOverviewSource(storedRow())?.instructions, null);
    for (const value of [
      null,
      "text",
      {},
      { selfDescription: null },
      { selfDescription: "x" },
      { selfDescription: {} },
      { selfDescription: { instructions: 7 } },
      { selfDescription: { instructions: "   " } },
    ]) {
      assert.equal(
        storedServerInstructions(value),
        null,
        JSON.stringify(value),
      );
    }
  });

  test("uses no README unless it was fetched with a hash", () => {
    for (const overrides of [
      { readmeStatus: "not_found" as const },
      { readmeStatus: "too_large" as const },
      { readmeSha256: null },
      { readmeSha256: "not-a-hash" },
      { readmeMd: null },
    ]) {
      assert.equal(mcpOverviewSource(storedRow(overrides))?.readme, null);
    }
  });

  test("never takes the summary for a description", () => {
    const manifest = {
      ...federatedManifest(genesis402RegistryServer),
      description: undefined,
      summary: "MCP server io.github.x/y from the MCP registry.",
    };
    const source = mcpOverviewSource(storedRow({ manifestJson: manifest }));
    assert.equal(source?.registryDescription, null);
  });

  test("a manifest that no longer parses gives no source", () => {
    assert.equal(mcpOverviewInputOf(storedRow({ manifestJson: {} })), null);
    assert.equal(
      mcpOverviewFingerprint({
        ...storedRow({ manifestJson: { transport: "carrier-pigeon" } }),
        hasReadmeText: true,
      }),
      null,
    );
  });
});

describe("the input fingerprint without README text", () => {
  test("equals the fingerprint of the full input", () => {
    for (const overrides of [
      {},
      { readmeStatus: "not_found" as const, readmeMd: null },
      { provenanceJson: {} },
    ]) {
      const row = storedRow(overrides);
      assert.equal(
        mcpOverviewFingerprint({
          ...row,
          hasReadmeText: row.readmeMd !== null,
        }),
        mcpOverviewInputOf(row)!.inputSha256,
      );
    }
  });

  test("changes with the README hash, the packages, the description and the instructions", () => {
    const base = mcpOverviewFingerprint({
      ...storedRow(),
      hasReadmeText: true,
    });
    const changed = [
      { readmeSha256: "a".repeat(64) },
      { provenanceJson: {} },
      {
        manifestJson: {
          ...federatedManifest(genesis402RegistryServer),
          description: "A different description of what it does.",
        },
      },
      {
        provenanceJson: {
          ...(storedRow().provenanceJson as Record<string, unknown>),
          selfDescription: { instructions: "Quote before paying." },
        },
      },
    ].map((overrides) =>
      mcpOverviewFingerprint({ ...storedRow(overrides), hasReadmeText: true }),
    );
    assert.equal(new Set(changed).size, changed.length);
    for (const fingerprint of changed) assert.notEqual(fingerprint, base);
    // Key order in stored JSON does not matter.
    const reordered = Object.fromEntries(
      Object.entries(
        federatedManifest(genesis402RegistryServer) as Record<string, unknown>,
      ).reverse(),
    );
    assert.equal(
      mcpOverviewFingerprint({
        ...storedRow({ manifestJson: reordered }),
        hasReadmeText: true,
      }),
      base,
    );
  });
});

describe("which analysed versions are queued again", () => {
  const row = storedRow();
  const current = mcpOverviewInputOf(row)!.inputSha256;
  const attempt = (
    overrides: Partial<McpOverviewAttempt>,
  ): McpOverviewAttempt => ({
    ...row,
    hasReadmeText: true,
    status: "ready",
    error: null,
    readmeReadSince: false,
    overviewSha256: current,
    ...overrides,
  });

  test("a current overview is left alone, even after the README is read again", () => {
    assert.equal(needsMcpOverviewRetry(attempt({})), false);
    assert.equal(
      needsMcpOverviewRetry(attempt({ readmeReadSince: true })),
      false,
    );
    assert.equal(
      needsMcpOverviewRetry(attempt({ status: "needs-review" })),
      false,
    );
  });

  test("an overview written from another input is regenerated", () => {
    assert.equal(
      needsMcpOverviewRetry(attempt({ overviewSha256: "b".repeat(64) })),
      true,
    );
    assert.equal(
      needsMcpOverviewRetry(attempt({ readmeSha256: "c".repeat(64) })),
      true,
    );
    assert.equal(
      needsMcpOverviewRetry(attempt({ overviewSha256: null })),
      true,
    );
  });

  test("a failure is retried when its reason has passed or the README was read again", () => {
    for (const error of [
      "not-eligible",
      "readme-pending",
      "system-model-not-ready",
    ]) {
      assert.equal(
        needsMcpOverviewRetry(attempt({ status: "failed", error })),
        true,
        error,
      );
    }
    for (const error of [
      "no-content",
      "invalid-manifest",
      "Analysis failed; check worker logs and retry",
    ]) {
      assert.equal(
        needsMcpOverviewRetry(attempt({ status: "failed", error })),
        false,
        error,
      );
      assert.equal(
        needsMcpOverviewRetry(
          attempt({ status: "failed", error, readmeReadSince: true }),
        ),
        true,
        error,
      );
    }
    // A failed regeneration keeps the old overview live; the stale fingerprint
    // alone does not make it try again on every pass.
    assert.equal(
      needsMcpOverviewRetry(
        attempt({
          status: "failed",
          error: "Analysis failed; check worker logs and retry",
          overviewSha256: "d".repeat(64),
        }),
      ),
      false,
    );
  });
});
