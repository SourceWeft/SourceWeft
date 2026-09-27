import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  marketMcpManifestSchema,
  type MarketMcpManifest,
} from "@sourceweft/market-contracts";
import { createRouteTestApp } from "../../test/hono";
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
