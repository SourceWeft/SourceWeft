import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  marketMcpManifestSchema,
  type MarketMcpManifest,
} from "@sourceweft/market-contracts";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

/**
 * The license / language sources and the summary translations against real
 * PostgreSQL: what the README fetch and the translation pass write on the
 * version's provenance, that a federation re-sync keeps it, which versions the
 * pass picks, and what the public read shows.
 */

vi.mock("../../../shared/mcp-auth-probe", () => ({
  probeMcpEndpointAuth: async () => "oauth",
}));

const tag = `md${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const NOW = new Date("2026-10-25T03:00:00Z");
const ENGLISH = `Search and read the pages of your ${tag} workspace.`;

function manifest(
  identifier: string,
  overrides: Partial<MarketMcpManifest> = {},
): MarketMcpManifest {
  return marketMcpManifestSchema.parse({
    schemaVersion: 1,
    identifier,
    version: "1.0.0",
    name: "Workspace",
    summary: ENGLISH,
    transport: "stdio",
    repoUrl: `https://github.com/acme/${tag}`,
    categories: [],
    ...overrides,
  });
}

describe("license, language and translated summaries", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let data: typeof import("@sourceweft/db");
  let ingest: typeof import("../ingest/repository");
  let plan: typeof import("../ingest/plan");
  let readme: typeof import("../readme/readme-repository");
  let repository: typeof import("./summary-translation-repository");
  let translation: typeof import("./summary-translation");
  let reads: typeof import("../read-repository");
  const originalUrl = process.env.DATABASE_URL;

  const identifier = `io.github.acme/${tag}`;
  const hostedIdentifier = `com.${tag}/mcp`;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase("mcp_metadata");
    process.env.DATABASE_URL = isolated.url;
    data = await import("@sourceweft/db");
    ingest = await import("../ingest/repository");
    plan = await import("../ingest/plan");
    readme = await import("../readme/readme-repository");
    repository = await import("./summary-translation-repository");
    translation = await import("./summary-translation");
    reads = await import("../read-repository");
  }, 120_000);

  afterAll(async () => {
    if (data) await data.closeDatabase();
    if (isolated) await isolated.close();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  async function upsert(
    manifestValue: MarketMcpManifest,
    provenanceJson: Record<string, unknown> = {},
  ) {
    await ingest.upsertMarketMcp({
      manifest: manifestValue,
      status: "published",
      visibility: "public",
      origin: "upstream",
      source: "registry.test",
      provenanceJson: { source: "registry.test", ...provenanceJson },
    });
  }

  async function provenanceOf(id: string, version = "1.0.0") {
    const [row] = await data.db
      .select({ provenanceJson: data.mcpServerVersions.provenanceJson })
      .from(data.mcpServerVersions)
      .where(
        eq(data.mcpServerVersions.id, plan.mcpServerVersionId(id, version)),
      );
    return row!.provenanceJson as Record<string, unknown>;
  }

  async function settleReadme(id: string, version = "1.0.0") {
    await data.db
      .update(data.mcpServerVersions)
      .set({ readmeStatus: "not_found" })
      .where(
        eq(data.mcpServerVersions.id, plan.mcpServerVersionId(id, version)),
      );
  }

  const candidateIdentifiers = async (now = NOW) =>
    (await repository.findSummaryTranslationCandidates({ limit: 50, now }))
      .filter((candidate) => candidate.identifier.includes(tag))
      .map((candidate) => candidate.identifier);

  test("the README fetch's repository record is read by the page and survives a re-sync", async () => {
    await upsert(manifest(identifier), {
      repository: { url: `https://github.com/acme/${tag}` },
    });
    const versionId = plan.mcpServerVersionId(identifier, "1.0.0");
    await readme.writeMcpRepositoryMetadata(versionId, {
      repository: `acme/${tag}`,
      subfolder: "",
      license: "Apache-2.0",
      language: "Rust",
      observedAt: NOW.toISOString(),
    });

    const shown = await reads.findMcp(identifier);
    expect(shown?.item.license).toBe("Apache-2.0");
    expect(shown?.item.language).toBe("Rust");

    // The sync rebuilds the provenance from the registry entry; the record is not the entry's.
    await upsert(manifest(identifier), {
      repository: { url: `https://github.com/acme/${tag}` },
    });
    expect((await provenanceOf(identifier)).repositoryMetadata).toMatchObject({
      license: "Apache-2.0",
    });
    expect((await reads.findMcp(identifier))?.item.license).toBe("Apache-2.0");

    // The entry moves to another repository: the old answer no longer applies.
    await upsert(manifest(identifier, { repoUrl: `https://github.com/acme/${tag}-moved` }), {
      repository: { url: `https://github.com/acme/${tag}-moved` },
    });
    const moved = await reads.findMcp(identifier);
    expect(moved?.item.license).toBeNull();
    expect(moved?.item.language).toBeNull();
  });

  test("a hosted service shows no license or language, whatever the repository says", async () => {
    await upsert(
      manifest(hostedIdentifier, {
        transport: "streamable_http",
        endpointUrl: `https://mcp.${tag}.com/mcp`,
        repoUrl: undefined,
      }),
      {
        registryServer: { remotes: [{ url: `https://mcp.${tag}.com/mcp` }] },
        githubRegistry: { name: `x/${tag}`, matchedBy: "name", license: "MIT", fetchedAt: NOW.toISOString() },
      },
    );
    const item = (await reads.findMcp(hostedIdentifier))?.item;
    expect(item?.license).toBeNull();
    expect(item?.language).toBeNull();
  });

  test("the pass picks versions with a settled README, no overview and a translatable summary", async () => {
    const id = `io.github.acme/${tag}-pick`;
    await upsert(manifest(id));
    // README still pending: the overview may yet speak for it.
    expect(await candidateIdentifiers()).not.toContain(id);
    await settleReadme(id);
    expect(await candidateIdentifiers()).toContain(id);

    // An overview already speaks the visitor's language.
    await data.db.insert(data.mcpServerVersionOverviews).values({
      mcpServerVersionId: plan.mcpServerVersionId(id, "1.0.0"),
      locale: "en",
      inputSha256: "x",
      overview: { summary: "s", whatItDoes: "w", whenToUse: "u", requirements: "r", cautions: null, suggestedCategories: [] },
      model: "m",
    });
    expect(await candidateIdentifiers()).not.toContain(id);
  });

  test("federation's placeholder summary is never a candidate", async () => {
    const id = `io.github.acme/${tag}-placeholder`;
    await upsert(manifest(id, { summary: `MCP server ${id} from the MCP registry.` }));
    await settleReadme(id);
    expect(await candidateIdentifiers()).not.toContain(id);
  });

  test("a stored translation is shown to a Chinese reader, survives a re-sync, and goes stale with the English", async () => {
    const id = `io.github.acme/${tag}-zh`;
    await upsert(manifest(id));
    await settleReadme(id);
    const versionId = plan.mcpServerVersionId(id, "1.0.0");
    await repository.writeSummaryTranslation(
      versionId,
      translation.translatedRecord({ summary: ENGLISH, zhCN: "搜索并读取你的工作区页面。", model: "m", now: NOW }),
    );

    expect(await candidateIdentifiers()).not.toContain(id);
    const zhCN = (await reads.findMcp(id, { locale: "zh-CN" }))?.item;
    expect(zhCN?.localizedSummary).toEqual({ locale: "zh-CN", text: "搜索并读取你的工作区页面。" });
    expect(zhCN?.summary).toBe(ENGLISH);
    expect(zhCN?.descriptionLanguage).toBe("en");
    expect((await reads.findMcp(id, { locale: "zh-TW" }))?.item.localizedSummary?.text).toBe(
      "搜尋並讀取你的工作區頁面。",
    );
    // English readers and the list endpoint's default keep the original.
    expect((await reads.findMcp(id))?.item.localizedSummary).toBeNull();

    // A re-sync with the same text keeps the record.
    await upsert(manifest(id));
    expect((await reads.findMcp(id, { locale: "zh-CN" }))?.item.localizedSummary?.text).toBe(
      "搜索并读取你的工作区页面。",
    );

    // The English changes: the record is stale — not shown, due again.
    await upsert(manifest(id, { summary: `${ENGLISH} Now with databases.` }));
    expect((await reads.findMcp(id, { locale: "zh-CN" }))?.item.localizedSummary).toBeNull();
    const [again] = (await repository.findSummaryTranslationCandidates({ limit: 50, now: NOW })).filter(
      (candidate) => candidate.identifier === id,
    );
    expect(again?.summary).toBe(`${ENGLISH} Now with databases.`);
    expect(translation.parseSummaryTranslation(again?.record)?.status).toBe("translated");
  });

  test("a failed attempt waits a day; a new version offers the earlier version's record", async () => {
    const id = `io.github.acme/${tag}-retry`;
    await upsert(manifest(id));
    await settleReadme(id);
    const versionId = plan.mcpServerVersionId(id, "1.0.0");
    await repository.writeSummaryTranslation(
      versionId,
      translation.settledRecord({ summary: ENGLISH, status: "failed", now: NOW }),
    );
    expect(await candidateIdentifiers(new Date(NOW.getTime() + 60_000))).not.toContain(id);
    expect(
      await candidateIdentifiers(
        new Date(NOW.getTime() + translation.MCP_SUMMARY_TRANSLATION_RETRY_MS + 1),
      ),
    ).toContain(id);

    // A newer version with the same text: the pass sees the earlier record.
    await repository.writeSummaryTranslation(
      versionId,
      translation.translatedRecord({ summary: ENGLISH, zhCN: "搜索页面。", model: "m", now: NOW }),
    );
    await upsert(manifest(id, { version: "2.0.0" }));
    await settleReadme(id, "2.0.0");
    const [candidate] = (await repository.findSummaryTranslationCandidates({ limit: 50, now: NOW })).filter(
      (entry) => entry.identifier === id,
    );
    expect(candidate?.versionId).toBe(plan.mcpServerVersionId(id, "2.0.0"));
    expect(candidate?.record).toBeNull();
    expect(translation.parseSummaryTranslation(candidate?.previous)?.["zh-CN"]).toBe("搜索页面。");
  });
});
