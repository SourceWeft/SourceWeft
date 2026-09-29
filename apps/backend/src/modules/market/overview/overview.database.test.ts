import { createHash, randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import type { RegistryServerJson } from "../types";
import { createRouteTestApp } from "../../../test/hono";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";
import { genesis402ModelAnswer } from "./test-answer";
import {
  carrerliftRegistryServer,
  federatedManifest,
  genesis402RegistryServer,
  readmeFixture,
} from "./test-fixtures";

/**
 * MCP AI overviews against real PostgreSQL: the tables, publication through
 * the catalog overview engine, category ownership, the scheduler's candidates
 * and the public and admin reads. The system model's door
 * (`withSystemModel`) is replaced by a fake that answers like the model
 * would; everything behind and in front of it is the real code. The queue is
 * Redis, so what would be queued is recorded and the worker's processor is
 * run on it directly.
 */

const state = vi.hoisted(() => ({
  userId: null as string | null,
  // Structured answers the fake system model gives, in order; the genesis402
  // answer once they run out.
  answers: [] as unknown[],
  calls: [] as Array<{ purpose: string; subjectRef: string }>,
  jobs: [] as Array<{
    name: string;
    data: Record<string, unknown>;
    opts: { jobId?: string; attempts?: number };
  }>,
}));

vi.mock("../../../api/middleware/auth-session", () => ({
  requireSession: async () =>
    state.userId
      ? {
          user: { id: state.userId },
          session: { id: "s", userId: state.userId },
        }
      : null,
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
}));
vi.mock("../admin", () => ({
  isMarketAdmin: (userId: string | null | undefined) =>
    userId === "market-admin",
}));
vi.mock(
  "../../../shared/model-gateway/system-client",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../../shared/model-gateway/system-client")
      >();
    return {
      ...original,
      getSystemModelReadiness: async () => ({
        enabled: true,
        configured: true,
        ready: true,
        provider: "openrouter",
        model: "fake/system-model",
        problems: [],
        reason: null,
      }),
      resolveSystemModelIdentity: async () => ({
        provider: "openrouter",
        kind: "openai-compatible",
        baseUrl: "https://openrouter.test/api/v1",
        apiVersion: null,
        model: "fake/system-model",
      }),
      withSystemModel: async (
        context: { purpose: string; subjectRef: string },
        run: (chat: {
          complete: (input: unknown) => Promise<unknown>;
        }) => Promise<unknown>,
      ) => {
        state.calls.push({
          purpose: context.purpose,
          subjectRef: context.subjectRef,
        });
        return run({
          complete: async () => ({
            model: "fake/system-model",
            provider: "openrouter",
            providerModel: "fake/system-model",
            structuredOutput: state.answers.shift() ?? genesis402ModelAnswer(),
            raw: { content: "" },
          }),
        });
      },
    };
  },
);
vi.mock("../../../shared/queue", () => ({
  enqueueWithAudit: async (
    name: string,
    data: Record<string, unknown>,
    opts: { jobId?: string; attempts?: number },
  ) => {
    state.jobs.push({ name, data, opts });
    return { id: opts.jobId };
  },
  jobsQueue: { getJob: async () => null },
}));

const COMMIT = "c0ffee".padEnd(40, "0");
const genesisReadme = readmeFixture("genesis402-mcp-readme.md");
const carrerliftReadme = readmeFixture("carrerlift-readme.md");

describe("MCP AI overviews (real PostgreSQL)", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let data: typeof import("@sourceweft/db");
  let ingest: typeof import("../ingest/repository");
  let plan: typeof import("../ingest/plan");
  let federation: typeof import("../federation");
  let registry: typeof import("../registry-server");
  let readmes: typeof import("../readme/readme-repository");
  let readmeState: typeof import("../readme/readme-state");
  let generate: typeof import("./generate");
  let repository: typeof import("./repository");
  let queue: typeof import("./queue");
  let admin: typeof import("./admin");
  let processor: typeof import("../../../worker/processors/mcp-overview-generate");
  let app: Hono;
  const originalUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase("mcp_overview");
    process.env.DATABASE_URL = isolated.url;
    data = await import("@sourceweft/db");
    ingest = await import("../ingest/repository");
    plan = await import("../ingest/plan");
    federation = await import("../federation");
    registry = await import("../registry-server");
    readmes = await import("../readme/readme-repository");
    readmeState = await import("../readme/readme-state");
    generate = await import("./generate");
    repository = await import("./repository");
    queue = await import("./queue");
    admin = await import("./admin");
    processor =
      await import("../../../worker/processors/mcp-overview-generate");
    const routes = await import("../../../api/routes/market");
    app = createRouteTestApp(routes.registerMarketRoutes);
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (data) await data.closeDatabase();
    if (isolated) await isolated.close();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  beforeEach(async () => {
    state.userId = null;
    state.answers = [];
    state.calls = [];
    state.jobs = [];
    // Every test starts from an empty catalog: the scans are catalog-wide.
    await data.db.delete(data.mcpServers);
    await data.db.delete(data.workspaceMcpInstalls);
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** A federated server as registry federation stores it; returns its ids. */
  async function seed(
    server: RegistryServerJson,
    options: {
      categories?: string[];
      status?: "published" | "reviewing";
      visibility?: "public" | "private";
      version?: string;
    } = {},
  ) {
    const manifest = {
      ...federatedManifest(server),
      ...(options.version ? { version: options.version } : {}),
      categories: options.categories ?? ["developer-tools"],
    };
    await ingest.upsertMarketMcp({
      manifest,
      status: options.status ?? "published",
      visibility: options.visibility ?? "public",
      origin: "upstream",
      source: "registry.test",
      provenanceJson: {
        source: "registry.test",
        registryServer: registry.registryServerProvenance(server),
      },
    });
    return {
      identifier: manifest.identifier,
      serverId: plan.mcpServerId(manifest.identifier),
      versionId: plan.mcpServerVersionId(manifest.identifier, manifest.version),
    };
  }

  /** The README fetch reads `markdown` for the version: out of `pending`. */
  async function readmeFetched(
    versionId: string,
    readme: { markdown: string; sha256: string },
  ) {
    const [row] = await data.db
      .select({
        readmeStatus: data.mcpServerVersions.readmeStatus,
        readmeAttempts: data.mcpServerVersions.readmeAttempts,
      })
      .from(data.mcpServerVersions)
      .where(eq(data.mcpServerVersions.id, versionId));
    await readmes.writeMcpReadmeColumns(
      versionId,
      readmeState.mcpReadmeTransition(
        row!,
        {
          status: "ok",
          markdown: readme.markdown,
          path: "README.md",
          ref: COMMIT,
          sha256: readme.sha256,
          byteSize: readme.markdown.length,
        },
        new Date(),
      ),
    );
  }

  /** The worker's processor on a job the scheduler (or an admin) queued. */
  async function runJob(job: (typeof state.jobs)[number]) {
    return processor.processMcpOverviewGenerateJob({
      id: job.opts.jobId,
      name: job.name,
      data: job.data,
      attemptsMade: 0,
      opts: { attempts: job.opts.attempts },
      updateData: async () => undefined,
    } as unknown as Job<Record<string, unknown>>);
  }

  async function tick(after = "") {
    const rotation = { after };
    const result = await queue.enqueueMcpOverviews(undefined, rotation);
    return { ...result, after: rotation.after };
  }

  async function categoriesOf(serverId: string) {
    const [server] = await data.db
      .select({ setBy: data.mcpServers.categoriesSetBy })
      .from(data.mcpServers)
      .where(eq(data.mcpServers.id, serverId));
    const rows = await data.db
      .select({ slug: data.mcpCategories.slug })
      .from(data.mcpServerCategories)
      .innerJoin(
        data.mcpCategories,
        eq(data.mcpCategories.id, data.mcpServerCategories.categoryId),
      )
      .where(eq(data.mcpServerCategories.serverId, serverId));
    return {
      setBy: server?.setBy,
      slugs: rows.map((row) => row.slug).sort(),
    };
  }

  async function overviewRows(versionId: string) {
    return data.db
      .select()
      .from(data.mcpServerVersionOverviews)
      .where(eq(data.mcpServerVersionOverviews.mcpServerVersionId, versionId));
  }

  async function detail(identifier: string, locale?: string) {
    const response = await app.request(
      `/v1/mcp/${encodeURIComponent(identifier)}${locale ? `?locale=${locale}` : ""}`,
    );
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      item: {
        aiSummary?: string | null;
        overviewLocales?: string[];
        categories: string[];
      };
      aiOverview: null | {
        summary: string;
        cautions: string | null;
        locale: string;
        generatedAt: string;
      };
    }>;
  }

  /** Generate and publish one version's overview with the fake model. */
  async function generated(
    versionId: string,
    answer?: unknown,
    options: { force?: boolean } = {},
  ) {
    if (answer) state.answers.push(answer);
    return generate.generateMcpOverview({
      versionId,
      scopeId: `test:${randomUUID()}`,
      modelConfigurationKey: "test-model-key",
      force: options.force,
    });
  }

  // -------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------

  test("both tables cascade from the version, and the server", async () => {
    const genesis = await seed(genesis402RegistryServer);
    await readmeFetched(genesis.versionId, genesisReadme);
    expect(await generated(genesis.versionId)).toMatchObject({
      status: "generated",
    });
    expect(await overviewRows(genesis.versionId)).toHaveLength(3);

    // The checks the shared constraints add.
    await expect(
      data.db.execute(sql`
        insert into ${data.mcpServerVersionOverviews}
          (mcp_server_version_id, locale, input_sha256, overview, model)
        values (${genesis.versionId}, 'fr', 'x', '{}'::jsonb, 'm')
      `),
    ).rejects.toThrow();
    await expect(
      data.db.execute(sql`
        update ${data.mcpServerVersionAnalysis} set status = 'done'
        where mcp_server_version_id = ${genesis.versionId}
      `),
    ).rejects.toThrow();

    await data.db
      .delete(data.mcpServerVersions)
      .where(eq(data.mcpServerVersions.id, genesis.versionId));
    expect(await overviewRows(genesis.versionId)).toHaveLength(0);
    expect(
      await repository.mcpOverviewRepository.read(genesis.versionId),
    ).toBeNull();

    const carrerlift = await seed(carrerliftRegistryServer);
    await readmeFetched(carrerlift.versionId, carrerliftReadme);
    state.answers.push(carrerliftAnswer());
    expect(await generated(carrerlift.versionId)).toMatchObject({
      status: "generated",
    });
    await data.db
      .delete(data.mcpServers)
      .where(eq(data.mcpServers.id, carrerlift.serverId));
    expect(await overviewRows(carrerlift.versionId)).toHaveLength(0);
    expect(
      await repository.mcpOverviewRepository.read(carrerlift.versionId),
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Publication
  // -------------------------------------------------------------------------

  test("publication writes all three locales and the classification at once, or nothing", async () => {
    const genesis = await seed(genesis402RegistryServer);
    await readmeFetched(genesis.versionId, genesisReadme);

    // An answer missing a locale is refused: nothing is written.
    const partial = genesis402ModelAnswer() as Record<string, unknown>;
    delete partial["zh-TW"];
    await expect(generated(genesis.versionId, partial)).rejects.toThrow(
      /zh-TW/,
    );
    expect(await overviewRows(genesis.versionId)).toHaveLength(0);

    // A classification the category write refuses rolls the locales back too.
    const store = repository.mcpOverviewStore;
    const request = await store.request(genesis.versionId, true);
    await store.claim(genesis.versionId, request!.requestId);
    const subject = await generate.loadMcpOverviewSubject(genesis.versionId);
    await expect(
      store.publish({
        subject: subject!,
        requestId: request!.requestId,
        resultKey: "k",
        model: "m",
        classification: {
          status: "ready",
          categories: [{ slug: "not-a-category", evidence: "x" }],
          rationale: "r",
        },
        overviews: {
          en: overviewJson("en"),
          "zh-CN": overviewJson("zh-CN"),
          "zh-TW": overviewJson("zh-TW"),
        },
      }),
    ).rejects.toThrow(/Invalid analysis category/);
    expect(await overviewRows(genesis.versionId)).toHaveLength(0);

    // A good answer lands whole. (Forced: the refused request above is still
    // the live one.)
    const result = await generated(genesis.versionId, undefined, {
      force: true,
    });
    expect(result).toEqual({ status: "generated", model: "fake/system-model" });
    const rows = await overviewRows(genesis.versionId);
    expect(rows.map((row) => row.locale).sort()).toEqual([
      "en",
      "zh-CN",
      "zh-TW",
    ]);
    const fingerprint = subject!.fingerprint;
    expect(new Set(rows.map((row) => row.inputSha256))).toEqual(
      new Set([fingerprint]),
    );
    const analysis = await repository.mcpOverviewRepository.read(
      genesis.versionId,
    );
    expect(analysis).toMatchObject({
      status: "ready",
      promptVersion: "2",
      classification: {
        status: "ready",
        categories: [
          { slug: "finance", evidence: "DeFi yields from 15,000+ pools" },
          {
            slug: "web-search-scraping",
            evidence:
              "Any public web page as clean text, title, headings and links.",
          },
        ],
      },
    });
    expect(state.calls.at(-1)).toEqual({
      purpose: "mcp_market.overview",
      subjectRef: `mcp-server-version:${genesis.versionId}`,
    });
  });

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------

  test("categories go from auto to ai; an admin's choice is never overwritten", async () => {
    const genesis = await seed(genesis402RegistryServer, {
      categories: ["developer-tools"],
    });
    await readmeFetched(genesis.versionId, genesisReadme);
    expect(await categoriesOf(genesis.serverId)).toEqual({
      setBy: "auto",
      slugs: ["developer-tools"],
    });
    await generated(genesis.versionId);
    expect(await categoriesOf(genesis.serverId)).toEqual({
      setBy: "ai",
      slugs: ["finance", "web-search-scraping"],
    });
    // The categories' own rows exist, named from the taxonomy.
    const [finance] = await data.db
      .select()
      .from(data.mcpCategories)
      .where(eq(data.mcpCategories.slug, "finance"));
    expect(finance?.name).toBe("Finance");

    const carrerlift = await seed(carrerliftRegistryServer, {
      categories: ["productivity-workflow"],
    });
    await data.db
      .update(data.mcpServers)
      .set({ categoriesSetBy: "admin" })
      .where(eq(data.mcpServers.id, carrerlift.serverId));
    await readmeFetched(carrerlift.versionId, carrerliftReadme);
    expect(
      await generated(carrerlift.versionId, carrerliftAnswer()),
    ).toMatchObject({ status: "generated" });
    expect(await categoriesOf(carrerlift.serverId)).toEqual({
      setBy: "admin",
      slugs: ["productivity-workflow"],
    });
    // The overview itself is published all the same.
    expect(await overviewRows(carrerlift.versionId)).toHaveLength(3);
  });

  test("a federation re-sync keeps the AI categories and the overview", async () => {
    const genesis = await seed(genesis402RegistryServer);
    await readmeFetched(genesis.versionId, genesisReadme);
    await generated(genesis.versionId);
    const before = await categoriesOf(genesis.serverId);
    expect(before.setBy).toBe("ai");

    // The real federation run over the same registry entry.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              servers: [{ server: genesis402RegistryServer }],
              metadata: { nextCursor: null },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const run = await federation.ingestFromRegistry({
      source: "registry.test",
      baseUrl: "https://registry.test",
      verified: true,
    });
    vi.unstubAllGlobals();
    expect(run.ingested).toBe(1);
    expect(await categoriesOf(genesis.serverId)).toEqual(before);
    expect(await overviewRows(genesis.versionId)).toHaveLength(3);
    // The packages federation keeps are what the overview reads: the
    // fingerprint is unchanged, so nothing is queued again.
    const [version] = await data.db
      .select({ provenance: data.mcpServerVersions.provenanceJson })
      .from(data.mcpServerVersions)
      .where(eq(data.mcpServerVersions.id, genesis.versionId));
    expect(
      JSON.stringify(
        (version!.provenance as { registryServer: unknown }).registryServer,
      ),
    ).toContain("GENESIS402_PAYER_KEY");
    const scan = await queue.findMcpOverviewCandidates({
      limit: 10,
      after: "",
    });
    expect(scan.candidates).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Reads and hiding
  // -------------------------------------------------------------------------

  test("aiOverview and aiSummary follow the locale with an English fallback", async () => {
    const genesis = await seed(genesis402RegistryServer);
    await readmeFetched(genesis.versionId, genesisReadme);
    await generated(genesis.versionId);

    const zhTw = await detail(genesis.identifier, "zh-TW");
    expect(zhTw.aiOverview).toMatchObject({
      locale: "zh-TW",
      summary: genesis402ModelAnswer()["zh-TW"].summary,
      // The model said none.
      cautions: null,
    });
    expect(zhTw.item.aiSummary).toBe(genesis402ModelAnswer()["zh-TW"].summary);
    expect(zhTw.item.overviewLocales).toEqual(["en", "zh-CN", "zh-TW"]);
    expect(zhTw.item.categories.sort()).toEqual([
      "finance",
      "web-search-scraping",
    ]);
    const en = await detail(genesis.identifier);
    expect(en.aiOverview).toMatchObject({ locale: "en" });
    expect(en.aiOverview?.cautions).toMatch(/GENESIS402_PAYER_KEY/);

    // One locale hidden: that language falls back to English, and is no
    // longer listed as translated.
    await data.db
      .update(data.mcpServerVersionOverviews)
      .set({ hidden: true })
      .where(
        sql`${data.mcpServerVersionOverviews.mcpServerVersionId} = ${genesis.versionId} and ${data.mcpServerVersionOverviews.locale} = 'zh-TW'`,
      );
    const fallback = await detail(genesis.identifier, "zh-TW");
    expect(fallback.aiOverview).toMatchObject({
      locale: "en",
      summary: genesis402ModelAnswer().en.summary,
    });
    expect(fallback.item.overviewLocales).toEqual(["en", "zh-CN"]);

    // The list carries the same summary and languages.
    const list = await app.request(
      "/v1/mcp?locale=zh-CN&query=genesis402&includeDesktopOnly=true",
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      items: Array<{
        identifier: string;
        aiSummary: string | null;
        overviewLocales: string[];
      }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      identifier: genesis.identifier,
      aiSummary: genesis402ModelAnswer()["zh-CN"].summary,
      overviewLocales: ["en", "zh-CN"],
    });

    // A server without an overview answers null, not an error.
    const carrerlift = await seed(carrerliftRegistryServer);
    const none = await detail(carrerlift.identifier, "zh-CN");
    expect(none.aiOverview).toBeNull();
    expect(none.item.aiSummary).toBeNull();
    expect(none.item.overviewLocales).toEqual([]);
  });

  test("an admin's hide survives regeneration; the page falls back to the description", async () => {
    const genesis = await seed(genesis402RegistryServer);
    await readmeFetched(genesis.versionId, genesisReadme);
    await generated(genesis.versionId);
    state.userId = "market-admin";

    const hide = await app.request(
      `/v1/market/admin/mcp/${encodeURIComponent(genesis.identifier)}/overview/hidden`,
      {
        method: "POST",
        body: JSON.stringify({ hidden: true }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(hide.status).toBe(200);
    expect(await hide.json()).toMatchObject({ hidden: true, updated: 3 });
    expect((await detail(genesis.identifier, "zh-CN")).aiOverview).toBeNull();

    // A forced regeneration from the admin: queued, run by the worker.
    const regenerate = await app.request(
      `/v1/market/admin/mcp/${encodeURIComponent(genesis.identifier)}/overview/regenerate`,
      { method: "POST" },
    );
    expect(regenerate.status).toBe(202);
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]!.data).toMatchObject({
      mcpServerVersionId: genesis.versionId,
      mcpServerId: genesis.serverId,
      reason: "regenerate",
    });
    state.answers.push(genesis402ModelAnswer({ summaryPrefix: "Again: " }));
    expect(await runJob(state.jobs[0]!)).toMatchObject({
      status: "generated",
    });
    const rows = await overviewRows(genesis.versionId);
    expect(rows.every((row) => row.hidden)).toBe(true);
    expect(rows.find((row) => row.locale === "en")?.overview.summary).toMatch(
      /^Again: /,
    );
    expect((await detail(genesis.identifier, "en")).aiOverview).toBeNull();

    // The admin view shows every row, hidden ones included.
    const view = await app.request(
      `/v1/market/admin/mcp/${encodeURIComponent(genesis.identifier)}/overview`,
    );
    expect(view.status).toBe(200);
    const adminView = (await view.json()) as {
      overviews: Array<{ hidden: boolean; current: boolean }>;
      analysis: { status: string };
      eligible: boolean;
      categoriesSource: string;
      systemModel: { ready: boolean };
    };
    expect(adminView.overviews).toHaveLength(3);
    expect(adminView.overviews.every((row) => row.hidden && row.current)).toBe(
      true,
    );
    expect(adminView).toMatchObject({
      eligible: true,
      categoriesSource: "ai",
      analysis: { status: "ready" },
      systemModel: { ready: true },
    });

    // Shown again.
    const show = await app.request(
      `/v1/market/admin/mcp/${encodeURIComponent(genesis.identifier)}/overview/hidden`,
      {
        method: "POST",
        body: JSON.stringify({ hidden: false }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(show.status).toBe(200);
    expect((await detail(genesis.identifier, "en")).aiOverview).toMatchObject({
      locale: "en",
    });
  });

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  test("candidates: settled README, latest published public version, installed > web > rest", async () => {
    const stdioServer = (name: string): RegistryServerJson => ({
      ...genesis402RegistryServer,
      name: `io.github.acme/${name}`,
    });
    const webServer = (name: string): RegistryServerJson => ({
      ...carrerliftRegistryServer,
      name: `io.github.acme/${name}`,
    });
    const installedStdio = await seed(stdioServer("installed-stdio"));
    const plainStdio = await seed(stdioServer("plain-stdio"));
    const web = await seed(webServer("web"));
    const pending = await seed(webServer("pending"));
    const reviewing = await seed(webServer("reviewing"), {
      status: "reviewing",
    });
    const hidden = await seed(webServer("private"), {
      visibility: "private",
    });
    const versioned = await seed(webServer("versioned"));
    const newer = await seed(webServer("versioned"), { version: "2.0.0" });
    await data.db.execute(sql`
      update ${data.mcpServerVersions}
      set published_at = case version when '2.0.0' then now() else now() - interval '1 day' end
      where server_id = ${versioned.serverId}
    `);
    for (const entry of [
      installedStdio,
      plainStdio,
      web,
      reviewing,
      hidden,
      versioned,
      newer,
    ]) {
      await readmeFetched(entry.versionId, genesisReadme);
    }
    const workspaceId = randomUUID();
    const teamId = randomUUID();
    await data.db.insert(data.workspaces).values({
      id: workspaceId,
      organizationId: teamId,
      name: "Overview priority",
      slug: `overview-priority-${workspaceId}`,
    });
    await data.db.insert(data.workspaceMcpInstalls).values({
      id: randomUUID(),
      teamId,
      workspaceId,
      marketIdentifier: installedStdio.identifier,
      name: "installed",
      transport: "stdio",
    });

    const scan = await queue.findMcpOverviewCandidates({
      limit: 50,
      after: "",
    });
    expect(scan.candidates).toHaveLength(4);
    expect(scan.candidates[0]).toMatchObject({
      versionId: installedStdio.versionId,
      installed: true,
      webExecutable: false,
      attempted: false,
    });
    expect(
      scan.candidates
        .slice(1, 3)
        .map((candidate) => candidate.versionId)
        .sort(),
    ).toEqual([web.versionId, newer.versionId].sort());
    expect(scan.candidates[3]!.versionId).toBe(plainStdio.versionId);
    expect(
      scan.candidates.some((candidate) =>
        [pending, reviewing, hidden, versioned]
          .map((entry) => entry.versionId)
          .includes(candidate.versionId),
      ),
    ).toBe(false);
  });

  test("end to end: README ok -> candidate -> job -> publish -> GET ?locale=zh-TW", async () => {
    const genesis = await seed(genesis402RegistryServer);

    // README still pending: not a candidate, nothing queued, no model call.
    expect(await tick()).toMatchObject({ queued: 0 });
    expect(state.jobs).toHaveLength(0);

    // The README fetch settles it; the next tick queues it.
    await readmeFetched(genesis.versionId, genesisReadme);
    expect(await tick()).toMatchObject({ queued: 1 });
    expect(state.jobs).toHaveLength(1);
    const [job] = state.jobs;
    expect(job).toMatchObject({
      name: "mcp-overview-generate",
      data: {
        mcpServerVersionId: genesis.versionId,
        mcpServerId: genesis.serverId,
        reason: "scheduled",
      },
      opts: { attempts: 3 },
    });
    // Reserved: the next tick does not queue it again.
    expect(await tick()).toMatchObject({ queued: 0 });

    // The worker runs it.
    expect(await runJob(job!)).toEqual({
      status: "generated",
      model: "fake/system-model",
    });
    expect(state.calls).toEqual([
      {
        purpose: "mcp_market.overview",
        subjectRef: `mcp-server-version:${genesis.versionId}`,
      },
    ]);

    const response = await detail(genesis.identifier, "zh-TW");
    expect(response.aiOverview).toEqual({
      summary: genesis402ModelAnswer()["zh-TW"].summary,
      whatItDoes: genesis402ModelAnswer()["zh-TW"].whatItDoes,
      whenToUse: genesis402ModelAnswer()["zh-TW"].whenToUse,
      requirements: genesis402ModelAnswer()["zh-TW"].requirements,
      cautions: null,
      locale: "zh-TW",
      generatedAt: expect.any(String),
    });
    console.log(
      "MCP overview end to end:",
      JSON.stringify(
        {
          job: job!.data,
          aiOverview: response.aiOverview,
          aiSummary: response.item.aiSummary,
          overviewLocales: response.item.overviewLocales,
          categories: response.item.categories,
        },
        null,
        2,
      ),
    );

    // Current: later ticks leave it alone.
    expect(await tick()).toMatchObject({ queued: 0 });
    expect(state.calls).toHaveLength(1);
  });

  test("a changed README makes the overview stale and it is regenerated; unchanged input is not", async () => {
    const genesis = await seed(genesis402RegistryServer);
    await readmeFetched(genesis.versionId, genesisReadme);
    await generated(genesis.versionId);
    const before = (await overviewRows(genesis.versionId))[0]!.inputSha256;

    // The README is read again, unchanged: not stale.
    await readmeFetched(genesis.versionId, genesisReadme);
    expect(await tick()).toMatchObject({ queued: 0 });

    // The README changed upstream.
    const edited = `${genesisReadme.markdown}\n\n## Limits\n\nEvery paid call is capped by GENESIS402_MAX_USD.\n`;
    await readmeFetched(genesis.versionId, {
      markdown: edited,
      sha256: createSha256(edited),
    });
    expect(await tick()).toMatchObject({ queued: 1 });
    expect(state.jobs[0]!.data).toMatchObject({ reason: "regenerate" });
    await runJob(state.jobs[0]!);
    const after = (await overviewRows(genesis.versionId))[0]!.inputSha256;
    expect(after).not.toBe(before);
    expect(await tick()).toMatchObject({ queued: 0 });
    expect(state.calls).toHaveLength(2);
  });

  test("a version with nothing to describe is failed once, not retried every tick", async () => {
    const quiet = await seed({
      ...carrerliftRegistryServer,
      name: "io.github.acme/quiet",
      description: "An MCP server.",
    });
    await data.db
      .update(data.mcpServerVersions)
      .set({ readmeStatus: "not_found", readmeFetchedAt: new Date() })
      .where(eq(data.mcpServerVersions.id, quiet.versionId));

    expect(await tick()).toMatchObject({ queued: 1 });
    expect(await runJob(state.jobs[0]!)).toEqual({
      status: "skipped",
      reason: "no-content",
    });
    expect(state.calls).toHaveLength(0);
    expect(
      await repository.mcpOverviewRepository.read(quiet.versionId),
    ).toMatchObject({ status: "failed", error: "no-content" });
    expect(await tick()).toMatchObject({ queued: 0 });

    const status = await admin.getMcpOverviewStatus();
    expect(status).toMatchObject({
      eligible: 1,
      withOverview: 0,
      missing: 1,
      failed: 1,
      systemModel: { ready: true },
    });
  });

  // ---------------------------------------------------------------------------

  function overviewJson(locale: string) {
    return {
      summary: `${locale} summary`,
      whatItDoes: "Does things.",
      whenToUse: "When needed.",
      requirements: "",
      cautions: null,
      suggestedCategories: ["finance"],
    };
  }

  function carrerliftAnswer() {
    const answer = genesis402ModelAnswer();
    answer.classification = {
      primary: {
        slug: "productivity-workflow",
        evidence:
          "Search fresh Indian jobs and internships, plus international intern and new-grad roles.",
      },
      secondary: [],
      rationale: "Job search.",
    };
    return answer;
  }
});

function createSha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
