import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  marketMcpManifestSchema,
  type MarketMcpManifest,
} from "@sourceweft/market-contracts";
import { createRouteTestApp } from "../../test/hono";
import { mcpServerVersionId } from "./ingest/plan";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

const state = vi.hoisted(() => ({
  userId: null as string | null,
  parse: vi.fn(),
}));

vi.mock("../../api/middleware/auth-session", () => ({
  requireSession: async () =>
    state.userId
      ? {
          user: { id: state.userId },
          session: { id: "s", userId: state.userId },
        }
      : null,
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
}));
vi.mock("./admin", () => ({
  isMarketAdmin: (userId: string | null | undefined) =>
    userId === "market-admin",
}));
vi.mock("./parse-repository", () => ({ parseMcpRepository: state.parse }));

// One tag per run keeps searches to this file's rows.
const tag = `cat${randomUUID().replaceAll("-", "").slice(0, 12)}`;

function manifest(
  name: string,
  overrides: Partial<MarketMcpManifest> = {},
): MarketMcpManifest {
  return marketMcpManifestSchema.parse({
    schemaVersion: 1,
    identifier: `io.github.${tag}/${name}`,
    version: "1.0.0",
    name: `${tag} ${name}`,
    summary: `${name} server`,
    transport: "streamable_http",
    endpointUrl: `https://${name}.example.com/mcp`,
    repoUrl: `https://github.com/${tag}/${name}`,
    sourceUrl: `https://github.com/${tag}/${name}`,
    categories: ["developer-tools"],
    ...overrides,
  });
}

describe("MCP catalog on the mcp_* tables", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let data: typeof import("@sourceweft/db");
  let ingest: typeof import("./ingest/repository");
  let app: Hono;
  const originalUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase("mcp_catalog");
    process.env.DATABASE_URL = isolated.url;
    data = await import("@sourceweft/db");
    ingest = await import("./ingest/repository");
    const routes = await import("../../api/routes/market");
    app = createRouteTestApp(routes.registerMarketRoutes);
  }, 120_000);

  afterAll(async () => {
    if (data) await data.closeDatabase();
    if (isolated) await isolated.close();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  async function categoriesOf(identifier: string) {
    const [server] = await data.db
      .select()
      .from(data.mcpServers)
      .where(eq(data.mcpServers.identifier, identifier));
    const rows = await data.db
      .select({ slug: data.mcpCategories.slug })
      .from(data.mcpServerCategories)
      .innerJoin(
        data.mcpCategories,
        eq(data.mcpCategories.id, data.mcpServerCategories.categoryId),
      )
      .where(eq(data.mcpServerCategories.serverId, server!.id));
    return {
      server: server!,
      slugs: rows.map((row) => row.slug).sort(),
    };
  }

  test("a federated server is listed, detailed, counted and served by manifest", async () => {
    const weather = manifest("weather", {
      categories: ["developer-tools", "databases"],
    });
    const federated = {
      status: "published" as const,
      visibility: "public" as const,
      origin: "upstream" as const,
      source: "registry.test",
    };
    await ingest.upsertMarketMcp({ ...federated, manifest: weather });
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: { ...weather, version: "1.1.0" },
    });

    const list = await app.request(`/v1/mcp?query=${tag}`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      items: Record<string, unknown>[];
      nextCursor: string | null;
    };
    expect(listed.nextCursor).toBeNull();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      identifier: weather.identifier,
      name: weather.name,
      status: "published",
      visibility: "public",
      transport: "streamable_http",
      runtime: "web",
    });
    expect((listed.items[0]!.categories as string[]).sort()).toEqual([
      "databases",
      "developer-tools",
    ]);
    expect(listed.items[0]).not.toHaveProperty("kind");

    const byCategory = await app.request(
      `/v1/mcp?query=${tag}&category=databases`,
    );
    expect(
      ((await byCategory.json()) as { items: unknown[] }).items,
    ).toHaveLength(1);

    const detail = await app.request(
      `/v1/mcp/${encodeURIComponent(weather.identifier)}`,
    );
    expect(detail.status).toBe(200);
    const detailed = (await detail.json()) as {
      item: Record<string, unknown>;
      versions: Record<string, unknown>[];
    };
    expect(detailed.item.latestVersion).toBe("1.1.0");
    expect(detailed.versions.map((version) => version.version).sort()).toEqual([
      "1.0.0",
      "1.1.0",
    ]);
    expect(Object.keys(detailed.versions[0]!).sort()).toEqual([
      "manifestJson",
      "provenanceJson",
      "publishedAt",
      "status",
      "version",
    ]);

    const served = await app.request(
      `/v1/mcp/${encodeURIComponent(weather.identifier)}/manifest?version=1.0.0`,
    );
    expect(served.status).toBe(200);
    const body = (await served.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["item", "manifest", "version"]);
    expect(body.manifest).toMatchObject({
      identifier: weather.identifier,
      version: "1.0.0",
    });

    const counts = await app.request(`/v1/mcp/category-counts?query=${tag}`);
    expect(await counts.json()).toEqual({
      counts: { databases: 1, "developer-tools": 1 },
      total: 1,
    });

    const categories = await app.request("/v1/mcp/categories");
    expect(
      ((await categories.json()) as { items: { slug: string }[] }).items.map(
        (item) => item.slug,
      ),
    ).toContain("databases");
  });

  test("listed tools are counted on the list, returned by the detail and read back for reuse", async () => {
    const tools = [
      {
        name: "search",
        description: "Search the index.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        annotations: { readOnlyHint: true },
        risk: "unknown" as const,
      },
      {
        name: "fetch",
        inputSchema: { type: "object" },
        annotations: {},
        risk: "unknown" as const,
      },
    ];
    const listed = manifest("listed", { tools });
    const unlisted = manifest("unlisted");
    const toolsListing = {
      endpointSha256: "a".repeat(64),
      toolsCount: 2,
      listedAt: "2026-10-24T00:00:00.000Z",
    };
    const federated = {
      status: "published" as const,
      visibility: "public" as const,
      origin: "upstream" as const,
      source: "registry.test",
    };
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: listed,
      provenanceJson: { toolsListing },
    });
    await ingest.upsertMarketMcp({ ...federated, manifest: unlisted });

    const list = await app.request(`/v1/mcp?query=${tag}&limit=100`);
    const items = ((await list.json()) as { items: Record<string, unknown>[] })
      .items;
    expect(
      Object.fromEntries(
        items.map((item) => [item.identifier, item.toolsCount]),
      ),
    ).toMatchObject({
      [listed.identifier]: 2,
      [unlisted.identifier]: 0,
    });

    const detail = await app.request(
      `/v1/mcp/${encodeURIComponent(listed.identifier)}`,
    );
    const detailed = (await detail.json()) as {
      item: { toolsCount: number };
      versions: { manifestJson: { tools: unknown[] } }[];
    };
    expect(detailed.item.toolsCount).toBe(2);
    expect(detailed.versions[0]!.manifestJson.tools).toEqual(tools);

    const stored = await ingest.findStoredEndpointProbes([
      "missing-version",
      ...[listed, unlisted].map((entry) =>
        mcpServerVersionId(entry.identifier, entry.version),
      ),
    ]);
    // Only the version with a listing (or a probe) is returned.
    expect([...stored.keys()]).toEqual([
      mcpServerVersionId(listed.identifier, listed.version),
    ]);
    expect(
      stored.get(mcpServerVersionId(listed.identifier, listed.version)),
    ).toEqual({ authProbe: undefined, toolsListing, tools });

    // A re-sync whose listing now has no tools brings the count back to 0.
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: { ...listed, tools: [] },
      provenanceJson: { toolsListing: { ...toolsListing, toolsCount: 0 } },
    });
    const relisted = await app.request(
      `/v1/mcp/${encodeURIComponent(listed.identifier)}`,
    );
    expect(
      ((await relisted.json()) as { item: { toolsCount: number } }).item
        .toolsCount,
    ).toBe(0);
  });

  test("a re-sync rewrites categories only while categories_set_by is auto", async () => {
    const federated = {
      status: "published" as const,
      visibility: "public" as const,
      origin: "upstream" as const,
      source: "registry.test",
    };
    const tools = manifest("tools", { categories: ["developer-tools"] });
    await ingest.upsertMarketMcp({ ...federated, manifest: tools });
    let current = await categoriesOf(tools.identifier);
    expect(current.server.categoriesSetBy).toBe("auto");
    expect(current.slugs).toEqual(["developer-tools"]);

    await ingest.upsertMarketMcp({
      ...federated,
      manifest: { ...tools, categories: ["databases"] },
    });
    expect((await categoriesOf(tools.identifier)).slugs).toEqual(["databases"]);

    for (const owner of ["admin", "ai"] as const) {
      await data.db
        .update(data.mcpServers)
        .set({ categoriesSetBy: owner })
        .where(eq(data.mcpServers.identifier, tools.identifier));
      await ingest.upsertMarketMcp({
        ...federated,
        manifest: {
          ...tools,
          name: `${tools.name} ${owner}`,
          categories: ["browser-automation"],
        },
      });
      current = await categoriesOf(tools.identifier);
      // The rest of the row still follows the registry.
      expect(current.server.name).toBe(`${tools.name} ${owner}`);
      expect(current.server.categoriesSetBy).toBe(owner);
      expect(current.slugs).toEqual(["databases"]);
    }

    // A submission shares the upsert and the same rule.
    await ingest.upsertMarketMcp({
      status: "published",
      visibility: "public",
      origin: "submitted",
      manifest: { ...tools, version: "2.0.0", categories: ["data-analytics"] },
    });
    expect((await categoriesOf(tools.identifier)).slugs).toEqual(["databases"]);
  });

  test("issue #367: a search puts the server its publisher runs first and lists the publisher", async () => {
    const federated = {
      status: "published" as const,
      visibility: "public" as const,
      origin: "upstream" as const,
      source: "registry.test",
    };
    const term = `${tag}notion`;
    // Three servers matching "<tag>notion": a third-party one published
    // later (so first in publication order), the publisher's own served from
    // its domain, and the publisher's other server hosted elsewhere.
    const community = manifest(`${term}-community`, {
      identifier: `io.github.${tag}/${term}-community`,
      endpointUrl: `https://${term}.fly.dev/mcp`,
    });
    const own = manifest(`${term}-own`, {
      identifier: `com.${term}/mcp`,
      name: `${tag} Notion`,
      endpointUrl: `https://mcp.${term}.com/mcp`,
      publisher: {
        domain: `${term}.com`,
        source: "registry-namespace",
        endpointMatch: true,
      },
    });
    const hosted = manifest(`${term}-hosted`, {
      identifier: `com.${term}/hosted`,
      endpointUrl: `https://${term}.example.net/mcp`,
      publisher: {
        domain: `${term}.com`,
        source: "registry-namespace",
        endpointMatch: false,
      },
    });
    for (const entry of [hosted, own, community]) {
      await ingest.upsertMarketMcp({ ...federated, manifest: entry });
      // Distinct publication instants, in this order.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const list = await app.request(`/v1/mcp?query=${term}`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      items: { identifier: string; publisher: unknown }[];
    };
    expect(listed.items.map((item) => item.identifier)).toEqual([
      own.identifier,
      community.identifier,
      hosted.identifier,
    ]);
    expect(listed.items[0]!.publisher).toEqual(own.publisher);
    expect(listed.items[1]!.publisher).toBeNull();
    expect(listed.items[2]!.publisher).toEqual(hosted.publisher);

    // Paged, the ranked row stays first and the cursor continues after it.
    const firstPage = await app.request(`/v1/mcp?query=${term}&limit=1`);
    const first = (await firstPage.json()) as {
      items: { identifier: string }[];
      nextCursor: string;
    };
    expect(first.items.map((item) => item.identifier)).toEqual([
      own.identifier,
    ]);
    const secondPage = await app.request(
      `/v1/mcp?query=${term}&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
    );
    const second = (await secondPage.json()) as {
      items: { identifier: string }[];
      nextCursor: string | null;
    };
    expect(second.items.map((item) => item.identifier)).toEqual([
      community.identifier,
      hosted.identifier,
    ]);
    expect(second.nextCursor).toBeNull();

    // Without a query, publication order stands.
    const browse = await app.request(`/v1/mcp?limit=100`);
    const browsed = (await browse.json()) as {
      items: { identifier: string }[];
    };
    const ours = browsed.items
      .map((item) => item.identifier)
      .filter((identifier) => identifier.includes(term));
    expect(ours).toEqual([
      community.identifier,
      own.identifier,
      hosted.identifier,
    ]);

    const detail = await app.request(
      `/v1/mcp/${encodeURIComponent(own.identifier)}`,
    );
    expect(
      ((await detail.json()) as { item: { publisher: unknown } }).item
        .publisher,
    ).toEqual(own.publisher);
  });

  describe("updated_at follows listed content, not sync runs", () => {
    const federated = {
      status: "published" as const,
      visibility: "public" as const,
      origin: "upstream" as const,
      source: "registry.test",
    };
    // Only Date is faked: each sync runs at a known instant, and the
    // per-sync lastIndexedAt changes exactly as it does in production.
    let clock = Date.parse("2026-10-01T00:00:00.000Z");
    async function syncAt(input: MarketMcpManifest) {
      clock += 60_000;
      vi.setSystemTime(clock);
      await ingest.upsertMarketMcp({ ...federated, manifest: input });
      const [row] = await data.db
        .select({ updatedAt: data.mcpServers.updatedAt })
        .from(data.mcpServers)
        .where(eq(data.mcpServers.identifier, input.identifier));
      return row!.updatedAt.toISOString();
    }

    beforeAll(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterAll(() => {
      vi.useRealTimers();
    });

    test("an unchanged re-sync keeps updated_at", async () => {
      const stable = manifest("stable");
      const first = await syncAt(stable);
      expect(await syncAt(stable)).toBe(first);
    });

    test("a changed listed field bumps updated_at", async () => {
      const edited = manifest("edited");
      const first = await syncAt(edited);
      const second = await syncAt({ ...edited, summary: "rewritten summary" });
      expect(second > first).toBe(true);
      expect(await syncAt({ ...edited, summary: "rewritten summary" })).toBe(
        second,
      );
    });

    test("a newly published version bumps updated_at", async () => {
      const versioned = manifest("versioned");
      const first = await syncAt(versioned);
      const second = await syncAt({ ...versioned, version: "1.1.0" });
      expect(second > first).toBe(true);
      expect(await syncAt({ ...versioned, version: "1.1.0" })).toBe(second);
    });

    test("an auto category change bumps updated_at", async () => {
      const sorted = manifest("sorted", { categories: ["developer-tools"] });
      const first = await syncAt(sorted);
      const second = await syncAt({ ...sorted, categories: ["databases"] });
      expect(second > first).toBe(true);
      expect(await syncAt({ ...sorted, categories: ["databases"] })).toBe(
        second,
      );
    });

    test("the same version going live bumps updated_at", async () => {
      const held = manifest("held");
      await syncAt(held);
      // Back in review, with the server row itself left as it was: only the
      // version's first publication can move updated_at on the next sync.
      const [server] = await data.db
        .select({ id: data.mcpServers.id })
        .from(data.mcpServers)
        .where(eq(data.mcpServers.identifier, held.identifier));
      await data.db
        .update(data.mcpServerVersions)
        .set({ status: "reviewing", publishedAt: null })
        .where(eq(data.mcpServerVersions.serverId, server!.id));
      const [before] = await data.db
        .select({ updatedAt: data.mcpServers.updatedAt })
        .from(data.mcpServers)
        .where(eq(data.mcpServers.id, server!.id));
      const published = await syncAt(held);
      expect(published > before!.updatedAt.toISOString()).toBe(true);
      expect(await syncAt(held)).toBe(published);
    });

    test("an unchanged re-sync writes nothing but the server and version upserts", async () => {
      const steady = manifest("steady", {
        categories: ["developer-tools", "databases"],
      });
      await syncAt(steady);
      const [server] = await data.db
        .select({ id: data.mcpServers.id })
        .from(data.mcpServers)
        .where(eq(data.mcpServers.identifier, steady.identifier));
      // xmin is the writing transaction: a row deleted and inserted again, or
      // upserted to the same values, gets a new one.
      const rowVersions = async () =>
        (
          await data.db.execute<{ row: string; xmin: string }>(sql`
            select 'link:' || c.slug as row, l.xmin::text as xmin
            from ${data.mcpServerCategories} l
            join ${data.mcpCategories} c on c.id = l.category_id
            where l.server_id = ${server!.id}
            union all
            select 'category:' || c.slug, c.xmin::text
            from ${data.mcpCategories} c
            where c.slug in ('developer-tools', 'databases')
            order by 1`)
        ).rows;
      const before = await rowVersions();
      expect(before.map((r) => r.row)).toEqual([
        "category:databases",
        "category:developer-tools",
        "link:databases",
        "link:developer-tools",
      ]);
      const select = vi.spyOn(data.db, "select");
      const insert = vi.spyOn(data.db, "insert");
      const remove = vi.spyOn(data.db, "delete");
      try {
        clock += 60_000;
        vi.setSystemTime(clock);
        await ingest.upsertMarketMcp({ ...federated, manifest: steady });
        // The server and version upserts; the version's first publication
        // is read from its own upsert, and the categories are read once and
        // left alone because they did not change.
        expect(insert).toHaveBeenCalledTimes(2);
        expect(select).toHaveBeenCalledTimes(1);
        expect(remove).not.toHaveBeenCalled();
      } finally {
        select.mockRestore();
        insert.mockRestore();
        remove.mockRestore();
      }
      expect(await rowVersions()).toEqual(before);
    });

    test("an ignored category change on owned categories keeps updated_at", async () => {
      const owned = manifest("owned", { categories: ["developer-tools"] });
      const first = await syncAt(owned);
      await data.db
        .update(data.mcpServers)
        .set({ categoriesSetBy: "admin" })
        .where(eq(data.mcpServers.identifier, owned.identifier));
      expect(await syncAt({ ...owned, categories: ["databases"] })).toBe(first);
    });
  });

  // Issue #367 W8: the servers integrating one product, grouped behind the
  // product's own server. The brand is a token of its own (`${tag}x`), so the
  // other rows of this file, whose names carry `${tag}`, stay out.
  test("a detail carries its product group, the publisher's own server first", async () => {
    const brand = `${tag}x`;
    const domain = `${brand}.com`;
    const federated = {
      status: "published" as const,
      visibility: "public" as const,
      origin: "upstream" as const,
      source: "registry.test",
    };
    const official = manifest("official", {
      identifier: `com.${brand}/mcp`,
      name: "Mcp",
      summary: `Official ${brand} MCP server`,
      endpointUrl: `https://mcp.${domain}/mcp`,
      repoUrl: undefined,
      sourceUrl: undefined,
      tools: ["search", "create-page"].map((name) => ({
        name,
        inputSchema: {},
        annotations: {},
        risk: "unknown" as const,
      })),
    });
    const integrations = [
      manifest("better", {
        identifier: `io.github.aviate/better-${brand}`,
        name: `Better ${brand}`,
        summary: "Markdown-first integration.",
      }),
      manifest("smithery", {
        identifier: `ai.smithery/smithery-${brand}`,
        name: `Smithery ${brand}`,
        summary: "Hosted integration.",
      }),
      manifest("camel", {
        identifier: "io.github.suekou/server",
        name: `${brand.charAt(0).toUpperCase()}${brand.slice(1)}MCP`,
        summary: "A camelCase name, a slug that says nothing.",
      }),
    ];
    // Mentions the product only in its summary: not an integration of it.
    const mention = manifest("mention", {
      identifier: `io.github.${tag}/notes`,
      name: `${tag} notes`,
      summary: `Notes that sync to ${brand} and Slack.`,
    });
    // Carries the brand inside a longer word.
    const longer = manifest("longer", {
      identifier: `io.github.${tag}/${brand}ally`,
      name: `${brand}ally`,
      summary: "Unrelated.",
    });
    for (const entry of [official, ...integrations, mention, longer]) {
      await ingest.upsertMarketMcp({ ...federated, manifest: entry });
    }
    // W2 writes the publisher on sync; this catalog copy sets it directly.
    await data.db
      .update(data.mcpServers)
      .set({
        metadataJson: sql`${data.mcpServers.metadataJson} || ${JSON.stringify({
          publisher: {
            domain,
            source: "registry-namespace",
            endpointMatch: true,
          },
        })}::jsonb`,
      })
      .where(eq(data.mcpServers.identifier, official.identifier));

    const detail = async (identifier: string) => {
      const response = await app.request(
        `/v1/mcp/${encodeURIComponent(identifier)}`,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        relatedProduct: {
          domain: string;
          brand: string;
          officialIdentifier: string;
          members: {
            identifier: string;
            name: string;
            publisherMatch: boolean;
            toolsCount: number;
          }[];
        } | null;
      };
    };

    const onOfficial = (await detail(official.identifier)).relatedProduct;
    expect(onOfficial).toMatchObject({
      domain,
      brand,
      officialIdentifier: official.identifier,
    });
    const members = onOfficial!.members;
    // The official server first, then the integrations newest first.
    expect(members.map((member) => member.identifier)).toEqual([
      official.identifier,
      integrations[2]!.identifier,
      integrations[1]!.identifier,
      integrations[0]!.identifier,
    ]);
    expect(members[0]).toMatchObject({
      name: "Mcp",
      publisherMatch: true,
      toolsCount: 2,
    });
    expect(members.slice(1).every((member) => !member.publisherMatch)).toBe(
      true,
    );
    expect(members[1]).toMatchObject({
      name: integrations[2]!.name,
      toolsCount: 0,
    });

    // Every member's page shows the same group.
    for (const integration of integrations) {
      expect((await detail(integration.identifier)).relatedProduct).toEqual(
        onOfficial,
      );
    }
    // A summary mention and a longer word are not members, and have no group.
    expect((await detail(mention.identifier)).relatedProduct).toBeNull();
    expect((await detail(longer.identifier)).relatedProduct).toBeNull();

    // Without an official server the brand has no group at all.
    await data.db
      .update(data.mcpServers)
      .set({ metadataJson: sql`${data.mcpServers.metadataJson} - 'publisher'` })
      .where(eq(data.mcpServers.identifier, official.identifier));
    expect((await detail(official.identifier)).relatedProduct).toBeNull();
    expect(
      (await detail(integrations[0]!.identifier)).relatedProduct,
    ).toBeNull();
  });

  test("a flagged submission waits for review, then publishes", async () => {
    const risky = manifest("risky");
    state.parse.mockResolvedValue({
      manifest: risky,
      report: {
        installCommands: ["curl https://risky.example.com/install | sh"],
        connections: [],
        github: { owner: tag, repo: "risky" },
      },
    });

    state.userId = null;
    const anonymous = await app.request("/v1/market/submissions", {
      method: "POST",
      body: JSON.stringify({ repoUrl: risky.repoUrl }),
      headers: { "content-type": "application/json" },
    });
    expect(anonymous.status).toBe(401);

    state.userId = "submitter";
    const submitted = await app.request("/v1/market/submissions", {
      method: "POST",
      body: JSON.stringify({ repoUrl: risky.repoUrl }),
      headers: { "content-type": "application/json" },
    });
    expect(submitted.status).toBe(201);
    expect(await submitted.json()).toEqual({
      identifier: risky.identifier,
      version: "1.0.0",
      status: "reviewing",
      flags: ["command:pipe-to-shell"],
    });
    const path = `/v1/mcp/${encodeURIComponent(risky.identifier)}`;
    expect((await app.request(path)).status).toBe(404);
    expect(await ingest.getMarketItemForSubmission(risky.identifier)).toEqual({
      hasUpstream: false,
      status: "reviewing",
      submittedBy: "submitter",
    });

    state.userId = "someone-else";
    const hijack = await app.request("/v1/market/submissions", {
      method: "POST",
      body: JSON.stringify({ repoUrl: risky.repoUrl }),
      headers: { "content-type": "application/json" },
    });
    expect(hijack.status).toBe(422);
    expect(await hijack.json()).toMatchObject({
      code: "MARKET_SUBMISSION_CONFLICT",
    });
    expect((await app.request("/v1/market/admin/submissions")).status).toBe(
      403,
    );

    state.userId = "market-admin";
    const queue = await app.request("/v1/market/admin/submissions");
    expect(queue.status).toBe(200);
    const queued = (
      (await queue.json()) as { items: Record<string, unknown>[] }
    ).items.find((item) => item.identifier === risky.identifier);
    expect(queued).toMatchObject({
      name: risky.name,
      repoUrl: risky.repoUrl,
      transport: "streamable_http",
      submittedBy: "submitter",
      flags: ["command:pipe-to-shell"],
    });

    const published = await app.request(
      `/v1/market/admin/submissions/${encodeURIComponent(risky.identifier)}/publish`,
      { method: "POST" },
    );
    expect(await published.json()).toEqual({
      identifier: risky.identifier,
      status: "published",
    });
    const detail = await app.request(path);
    expect(detail.status).toBe(200);
    expect(
      ((await detail.json()) as { versions: { status: string }[] }).versions,
    ).toEqual([expect.objectContaining({ status: "published" })]);

    const rejected = manifest("rejected");
    state.userId = "submitter";
    state.parse.mockResolvedValue({
      manifest: rejected,
      report: {
        installCommands: ["sudo make install"],
        connections: [],
        github: { owner: tag, repo: "rejected" },
      },
    });
    await app.request("/v1/market/submissions", {
      method: "POST",
      body: JSON.stringify({ repoUrl: rejected.repoUrl }),
      headers: { "content-type": "application/json" },
    });
    state.userId = "market-admin";
    const reject = await app.request(
      `/v1/market/admin/submissions/${encodeURIComponent(rejected.identifier)}/reject`,
      { method: "POST" },
    );
    expect(await reject.json()).toEqual({
      identifier: rejected.identifier,
      status: "archived",
    });
    const [archived] = await data.db
      .select()
      .from(data.mcpServerVersions)
      .innerJoin(
        data.mcpServers,
        eq(data.mcpServers.id, data.mcpServerVersions.serverId),
      )
      .where(eq(data.mcpServers.identifier, rejected.identifier));
    expect(archived!.mcp_server_versions.status).toBe("archived");
    expect(
      (await app.request(`/v1/mcp/${encodeURIComponent(rejected.identifier)}`))
        .status,
    ).toBe(404);
  });
});
