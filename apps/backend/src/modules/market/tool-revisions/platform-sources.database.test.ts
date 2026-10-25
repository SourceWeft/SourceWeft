import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { marketMcpManifestSchema } from "@sourceweft/market-contracts";
import { createRouteTestApp } from "../../../test/hono";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

/**
 * The platform's reference snapshot and members' observations (Issue #367):
 * who may submit, what a snapshot is pinned to, what is kept from a member's
 * discovery, which source the page shows, and how an admin takes one down.
 */

const state = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("../../../api/middleware/auth-session", () => ({
  requireSession: async () =>
    state.userId
      ? { user: { id: state.userId }, session: { id: "s", userId: state.userId } }
      : null,
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
}));
vi.mock("../admin", () => ({
  isMarketAdmin: (userId: string | null | undefined) => userId === "market-admin",
}));

const tag = `psn${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const enc = encodeURIComponent;
const ENDPOINT = `https://mcp.${tag}.com/mcp`;
const ORIGIN = `https://mcp.${tag}.com`;

const tool = (name: string, description = "", inputSchema: Record<string, unknown> = { type: "object" }) => ({
  name,
  description,
  inputSchema,
  annotations: {},
});

const profile = {
  tier: "free",
  role: "member",
  scopes: ["read"],
  date: "2026-10-20",
};

function manifest(identifier: string, endpointUrl: string | undefined = ENDPOINT) {
  return marketMcpManifestSchema.parse({
    schemaVersion: 1,
    identifier,
    version: "1.0.0",
    name: identifier,
    summary: "Summary",
    description: "Description",
    transport: "streamable_http",
    ...(endpointUrl ? { endpointUrl } : {}),
    categories: ["developer-tools"],
    tools: [],
  });
}

describe("platform snapshot and member-observed tools", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let data: typeof import("@sourceweft/db");
  let revisions: typeof import("./index");
  let member: typeof import("./member-observed");
  let app: Hono;
  const originalUrl = process.env.DATABASE_URL;
  let counter = 0;

  async function item(options: { endpointUrl?: string | null; tools?: unknown[] } = {}) {
    const identifier = `io.github.${tag}n${counter++}/server`;
    const endpointUrl = options.endpointUrl === null ? undefined : (options.endpointUrl ?? ENDPOINT);
    const base = manifest(identifier, endpointUrl);
    await (await import("../ingest/repository")).upsertMarketMcp({
      status: "published",
      visibility: "public",
      origin: "upstream",
      source: "registry.test",
      manifest: options.tools ? { ...base, tools: options.tools as never } : base,
    });
    const [row] = await data.db
      .select({ id: data.mcpServers.id })
      .from(data.mcpServers)
      .where(eq(data.mcpServers.identifier, identifier));
    return { identifier, itemId: row!.id };
  }
  const rowsOf = (itemId: string, source: "platform-indexed" | "member-observed" | "owner") =>
    data.db
      .select()
      .from(data.marketMcpToolRevisions)
      .where(
        and(
          eq(data.marketMcpToolRevisions.itemId, itemId),
          eq(data.marketMcpToolRevisions.source, source),
        ),
      )
      .orderBy(asc(data.marketMcpToolRevisions.revision));
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const submit = (identifier: string, overrides: Record<string, unknown> = {}) =>
    post("/v1/market/admin/mcp/platform-snapshots", {
      identifier,
      endpointOrigin: ORIGIN,
      endpointUrl: ENDPOINT,
      tools: [tool("search", "Search things"), tool("get", "Get a thing")],
      referenceProfile: profile,
      observedAt: new Date().toISOString(),
      ...overrides,
    });
  const detail = async (identifier: string) =>
    (await (await app.request(`/v1/mcp/${enc(identifier)}`)).json()) as {
      item: { toolsCount: number };
      versions: Array<{ manifestJson: { tools: Array<Record<string, unknown>>; toolsReference?: Record<string, unknown> } }>;
      toolsRevision: { source: string; revision: number } | null;
    };
  const observe = (itemEndpoint: { identifier: string }, overrides: Record<string, unknown> = {}) =>
    member.recordMemberObservedTools({
      marketIdentifier: itemEndpoint.identifier,
      endpointUrl: ENDPOINT,
      tools: [{ name: "list_pages", description: "List pages", inputSchema: { type: "object" } }],
      complete: true,
      ...overrides,
    });

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase("platform_sources");
    process.env.DATABASE_URL = isolated.url;
    data = await import("@sourceweft/db");
    revisions = await import("./index");
    member = await import("./member-observed");
    const market = await import("../../../api/routes/market");
    const claims = await import("../../../api/routes/market-claims");
    app = createRouteTestApp((hono) => {
      market.registerMarketRoutes(hono);
      claims.registerMarketClaimRoutes(hono);
    });
  }, 120_000);

  afterAll(async () => {
    if (data) await data.closeDatabase();
    if (isolated) await isolated.close();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  beforeEach(() => {
    state.userId = "market-admin";
  });

  describe("the admin endpoint", () => {
    test("only a market admin may submit", async () => {
      const { identifier } = await item();
      state.userId = null;
      expect((await submit(identifier)).status).toBe(401);
      state.userId = "someone";
      expect((await submit(identifier)).status).toBe(403);
      state.userId = "market-admin";
      expect((await submit(identifier)).status).toBe(201);
      state.userId = "someone";
      expect(
        (await post("/v1/market/admin/mcp/tool-sources", {
          identifier,
          source: "platform-indexed",
          action: "takedown",
        })).status,
      ).toBe(403);
    });

    test("a snapshot becomes revision 1; the same list again confirms it; a change is revision 2", async () => {
      const { identifier, itemId } = await item();
      const first = await submit(identifier, { observedAt: "2026-10-24T10:00:00.000Z" });
      expect(first.status).toBe(201);
      expect(await first.json()).toMatchObject({
        identifier,
        outcome: "created",
        revision: 1,
        toolsCount: 2,
      });
      const again = await submit(identifier, { observedAt: "2026-10-25T10:00:00.000Z" });
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ outcome: "confirmed", revision: 1 });
      const changed = await submit(identifier, {
        observedAt: "2026-10-26T10:00:00.000Z",
        tools: [tool("search", "Search things"), tool("get", "Get a thing"), tool("put")],
      });
      expect(await changed.json()).toMatchObject({ outcome: "created", revision: 2 });
      const rows = await rowsOf(itemId, "platform-indexed");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        referenceProfileJson: profile,
        lastConfirmedAt: new Date("2026-10-25T10:00:00.000Z"),
      });
      expect(rows[0]?.endpointKey).toMatch(/^[0-9a-f]{64}$/);
    });

    test("the page shows the snapshot's tools, risk unknown, labelled with its profile and date", async () => {
      const { identifier } = await item();
      await submit(identifier, { observedAt: "2026-10-24T10:00:00.000Z" });
      const page = await detail(identifier);
      expect(page.toolsRevision).toMatchObject({ source: "platform-indexed", revision: 1 });
      expect(page.item.toolsCount).toBe(2);
      const manifestJson = page.versions[0]!.manifestJson;
      expect(manifestJson.tools.map((entry) => entry.name)).toEqual(["get", "search"]);
      expect(manifestJson.tools.every((entry) => entry.risk === "unknown")).toBe(true);
      expect(manifestJson.tools.every((entry) => entry.source === "platform-indexed")).toBe(true);
      expect(manifestJson.toolsReference).toEqual({
        source: "platform-indexed",
        observedAt: "2026-10-24T10:00:00.000Z",
        stale: false,
        profile,
      });
      const viaManifest = await (
        await app.request(`/v1/mcp/${enc(identifier)}/manifest`)
      ).json();
      expect(viaManifest.manifest.toolsReference).toMatchObject({ stale: false });
    });

    test("a later endpoint change marks the snapshot stale; a new snapshot at the new address clears it", async () => {
      const { identifier, itemId } = await item();
      await submit(identifier);
      const moved = `https://mcp2.${tag}.com/mcp`;
      await data.db.execute(sql`
        update mcp_server_versions
        set manifest_json = jsonb_set(manifest_json, '{endpointUrl}', to_jsonb(${moved}::text))
        where server_id = ${itemId}`);
      expect((await detail(identifier)).versions[0]!.manifestJson.toolsReference).toMatchObject({
        stale: true,
      });
      // The old address is no longer accepted.
      const stale = await submit(identifier);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "MCP_SNAPSHOT_ENDPOINT_CHANGED" });
      const fresh = await submit(identifier, {
        endpointOrigin: `https://mcp2.${tag}.com`,
        endpointUrl: moved,
        observedAt: new Date(Date.now() + 1000).toISOString(),
      });
      expect(fresh.status).toBe(200);
      expect((await detail(identifier)).versions[0]!.manifestJson.toolsReference).toMatchObject({
        stale: false,
      });
    });

    describe("origin pinning", () => {
      test.each([
        ["a different path", { endpointUrl: `${ORIGIN}/other` }],
        ["a different port", { endpointOrigin: `${ORIGIN}:8443`, endpointUrl: `${ORIGIN}:8443/mcp` }],
        ["a different scheme", { endpointOrigin: ORIGIN.replace("https", "http"), endpointUrl: ENDPOINT.replace("https", "http") }],
        ["a different host", { endpointOrigin: "https://evil.example", endpointUrl: "https://evil.example/mcp" }],
        ["a subdomain", { endpointOrigin: `https://x.mcp.${tag}.com`, endpointUrl: `https://x.mcp.${tag}.com/mcp` }],
        ["userinfo in the URL", { endpointUrl: `https://u:p@mcp.${tag}.com/mcp` }],
        ["userinfo as host lookalike", { endpointUrl: `https://mcp.${tag}.com@evil.example/mcp` }],
        ["userinfo in the origin", { endpointOrigin: `https://u@mcp.${tag}.com` }],
        ["a query the listing does not have", { endpointUrl: `${ENDPOINT}?tenant=a` }],
        ["an origin that is not the URL's", { endpointOrigin: "https://other.example" }],
        ["an origin with a path", { endpointOrigin: `${ORIGIN}/mcp` }],
        ["not a URL", { endpointUrl: "mcp" }],
      ])("is refused for %s", async (_name, overrides) => {
        const { identifier, itemId } = await item();
        const response = await submit(identifier, overrides);
        expect([409, 422]).toContain(response.status);
        expect(await rowsOf(itemId, "platform-indexed")).toHaveLength(0);
      });

      test.each([
        ["upper-case host", { endpointOrigin: ORIGIN.toUpperCase().replace("HTTPS", "https"), endpointUrl: ENDPOINT.replace(`mcp.${tag}.com`, `MCP.${tag.toUpperCase()}.COM`) }],
        ["a trailing dot", { endpointOrigin: `${ORIGIN}.`, endpointUrl: `https://mcp.${tag}.com./mcp` }],
        ["the default port", { endpointOrigin: `${ORIGIN}:443`, endpointUrl: `https://mcp.${tag}.com:443/mcp` }],
      ])("is accepted with %s (the same endpoint)", async (_name, overrides) => {
        const { identifier } = await item();
        expect((await submit(identifier, overrides)).status).toBe(201);
      });

      test("is judged against the listing's current endpoint, with no network", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const { identifier } = await item();
        await submit(identifier);
        await submit(identifier, { endpointUrl: `${ORIGIN}/nope` });
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
      });

      test("a listing without a remote endpoint, or one that does not exist, takes no snapshot", async () => {
        const stdio = await item({ endpointUrl: null });
        const response = await submit(stdio.identifier);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "MCP_SNAPSHOT_NO_ENDPOINT" });
        expect((await submit(`io.github.${tag}missing/server`)).status).toBe(404);
      });

      test("an endpoint path or query secret is never stored", async () => {
        const secret = `https://mcp.${tag}.com/s/SECRETPATH?key=SECRETQUERY`;
        const { identifier, itemId } = await item({ endpointUrl: secret });
        expect(
          (await submit(identifier, { endpointOrigin: ORIGIN, endpointUrl: secret })).status,
        ).toBe(201);
        expect(JSON.stringify(await rowsOf(itemId, "platform-indexed"))).not.toMatch(/SECRET/);
      });
    });

    describe("limits", () => {
      test("more than 200 tools, an oversize tool, a deep schema and a duplicate name are refused", async () => {
        const { identifier, itemId } = await item();
        const many = Array.from({ length: 201 }, (_, index) => tool(`t${index}`));
        expect((await submit(identifier, { tools: many })).status).toBe(400);
        const big = tool("big", "", { type: "object", pad: "x".repeat(33 * 1024) });
        expect((await submit(identifier, { tools: [big] })).status).toBe(400);
        let deep: Record<string, unknown> = { type: "string" };
        for (let i = 0; i < 70; i++) deep = { items: deep };
        expect((await submit(identifier, { tools: [tool("deep", "", deep)] })).status).toBe(400);
        // A body deep enough to overflow a recursive walk is refused, not crashed on.
        let abyss = '{"type":"string"}';
        for (let i = 0; i < 3_000; i++) abyss = `{"items":${abyss}}`;
        const raw = `{"identifier":${JSON.stringify(identifier)},"endpointOrigin":${JSON.stringify(ORIGIN)},"endpointUrl":${JSON.stringify(ENDPOINT)},"tools":[{"name":"x","inputSchema":${abyss}}],"referenceProfile":${JSON.stringify(profile)},"observedAt":"2026-10-24T10:00:00.000Z"}`;
        expect((await post("/v1/market/admin/mcp/platform-snapshots", raw)).status).toBe(400);
        const dup = [tool("same"), tool("same")];
        expect((await submit(identifier, { tools: dup })).status).toBe(422);
        expect(await rowsOf(itemId, "platform-indexed")).toHaveLength(0);
      });

      test("unknown fields and a malformed profile are refused", async () => {
        const { identifier } = await item();
        expect((await submit(identifier, { extra: true })).status).toBe(400);
        expect((await submit(identifier, { referenceProfile: { ...profile, date: "yesterday" } })).status).toBe(400);
        expect((await submit(identifier, { referenceProfile: { ...profile, email: "a@b.c" } })).status).toBe(400);
      });

      test("a key named __proto__ stays a key and pollutes nothing", async () => {
        const { identifier, itemId } = await item();
        const raw = `{"identifier":${JSON.stringify(identifier)},"endpointOrigin":${JSON.stringify(ORIGIN)},"endpointUrl":${JSON.stringify(ENDPOINT)},"tools":[{"name":"p","inputSchema":{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"}}}}],"referenceProfile":${JSON.stringify(profile)},"observedAt":"2026-10-24T10:00:00.000Z"}`;
        expect((await post("/v1/market/admin/mcp/platform-snapshots", raw)).status).toBe(201);
        const [row] = await rowsOf(itemId, "platform-indexed");
        const stored = (row!.toolsJson as Array<{ inputSchema: { properties: Record<string, unknown> } }>)[0]!;
        expect(Object.keys(stored.inputSchema.properties).sort()).toEqual(["__proto__", "constructor"]);
        expect(({} as Record<string, unknown>).type).toBeUndefined();
      });

      test("a time in the future, or older than the latest snapshot, is refused", async () => {
        const { identifier } = await item();
        const future = await submit(identifier, {
          observedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
        expect(future.status).toBe(422);
        expect(await submit(identifier, { observedAt: "2026-10-24T10:00:00.000Z" })).toHaveProperty("status", 201);
        const older = await submit(identifier, {
          observedAt: "2026-10-23T10:00:00.000Z",
          tools: [tool("other")],
        });
        expect(older.status).toBe(409);
        expect(await older.json()).toMatchObject({ code: "MCP_SNAPSHOT_OLDER_THAN_LATEST" });
      });
    });

    test("an empty list is a valid snapshot, and the page then shows no tools from it", async () => {
      const { identifier } = await item();
      expect((await submit(identifier, { tools: [] })).status).toBe(201);
      const page = await detail(identifier);
      expect(page.toolsRevision).toMatchObject({ source: "platform-indexed" });
      expect(page.versions[0]!.manifestJson.tools).toEqual([]);
    });
  });

  describe("which source the page shows", () => {
    test("an owner's list outranks the snapshot, which outranks members' observation", async () => {
      const { identifier, itemId } = await item();
      await observe({ identifier });
      expect((await detail(identifier)).toolsRevision?.source).toBe("member-observed");
      await submit(identifier);
      const page = await detail(identifier);
      expect(page.toolsRevision?.source).toBe("platform-indexed");
      // No mixing: only the snapshot's two tools, none of the member's.
      expect(page.versions[0]!.manifestJson.tools.map((entry) => entry.name)).toEqual(["get", "search"]);
      // With the owner's list visible, neither is applied.
      expect(await revisions.readReferenceTools(itemId, true, false)).toBeNull();
    });

    test("members' observation never replaces tools the registry or a probe listed", async () => {
      const { identifier } = await item({ tools: [tool("registry_tool")] });
      await observe({ identifier });
      const page = await detail(identifier);
      expect(page.toolsRevision).toBeNull();
      expect(page.versions[0]!.manifestJson.tools.map((entry) => entry.name)).toEqual(["registry_tool"]);
      expect(page.versions[0]!.manifestJson.toolsReference).toBeUndefined();
      const history = await (await app.request(`/v1/mcp/${enc(identifier)}/tools/revisions`)).json();
      expect(history).toMatchObject({ source: null, items: [] });
    });

    test("the snapshot does replace them: SourceWeft's own authenticated read is the better list", async () => {
      const { identifier } = await item({ tools: [tool("registry_tool")] });
      await submit(identifier);
      const page = await detail(identifier);
      expect(page.versions[0]!.manifestJson.tools.map((entry) => entry.name)).toEqual(["get", "search"]);
    });
  });

  describe("a member's observation", () => {
    test("is recorded as member-observed, risk unknown, labelled to the day", async () => {
      const entry = await item();
      expect(await observe(entry)).toEqual({ recorded: true, outcome: "created" });
      const page = await detail(entry.identifier);
      expect(page.toolsRevision).toMatchObject({ source: "member-observed", revision: 1 });
      const manifestJson = page.versions[0]!.manifestJson;
      expect(manifestJson.tools).toMatchObject([{ name: "list_pages", risk: "unknown", source: "member-observed" }]);
      const reference = manifestJson.toolsReference as { observedAt: string; profile: unknown; stale: boolean };
      expect(reference.observedAt).toMatch(/T00:00:00\.000Z$/);
      expect(reference.profile).toBeNull();
      expect(reference.stale).toBe(false);
    });

    test("the same list only confirms; every real difference is a new revision", async () => {
      const entry = await item();
      await observe(entry);
      expect(await observe(entry)).toEqual({ recorded: true, outcome: "confirmed" });
      const changed = await observe(entry, {
        tools: [{ name: "list_pages", description: "List all pages", inputSchema: { type: "object" } }],
      });
      expect(changed).toEqual({ recorded: true, outcome: "created" });
      expect(await rowsOf(entry.itemId, "member-observed")).toHaveLength(2);
    });

    test("keeps only name, description and schema structure, and nothing about who connected", async () => {
      const entry = await item();
      await observe(entry, {
        tools: [
          {
            name: "query",
            description: "Run a query",
            inputSchema: {
              type: "object",
              properties: {
                project: { type: "string", enum: ["Acme", "Secret Project"], default: "Secret Project" },
              },
            },
          },
        ],
      });
      const [row] = await rowsOf(entry.itemId, "member-observed");
      expect(row!.toolsJson).toEqual([
        {
          name: "query",
          description: "Run a query",
          inputSchema: { type: "object", properties: { project: { type: "string" } } },
          annotations: {},
        },
      ]);
      expect(JSON.stringify(row)).not.toMatch(/Secret|Acme/);
      // The table has no member, team, workspace or install column at all.
      const columns = await data.db.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns where table_name = 'market_mcp_tool_revisions'`,
      );
      expect(columns.rows.map((column) => column.column_name).filter((name) => /user|member|team|workspace|install|account/.test(name))).toEqual([]);
    });

    test.each([
      ["an endpoint edited away from the listing's", { endpointUrl: `https://evil.example/mcp` }],
      ["a different path on the same host", { endpointUrl: `${ORIGIN}/other` }],
      ["a query the listing does not have", { endpointUrl: `${ENDPOINT}?tenant=a` }],
      ["userinfo", { endpointUrl: `https://u:p@mcp.${tag}.com/mcp` }],
      ["no endpoint", { endpointUrl: null }],
      ["an install that is not from the catalog", { marketIdentifier: null }],
      ["an unknown listing", { marketIdentifier: `io.github.${tag}nope/server` }],
      ["a cut-off list", { complete: false }],
      ["an empty list", { tools: [] }],
    ])("records nothing for %s", async (_name, overrides) => {
      const entry = await item();
      const result = await observe(entry, overrides);
      expect(result.recorded).toBe(false);
      expect(await rowsOf(entry.itemId, "member-observed")).toHaveLength(0);
    });

    test("records nothing for an account-specific gateway, even when the listing is on it", async () => {
      const gatewayEndpoint = "https://mcp.zapier.com/api/mcp/mcp";
      const entry = await item({ endpointUrl: gatewayEndpoint });
      const result = await observe(entry, { endpointUrl: gatewayEndpoint });
      expect(result).toEqual({ recorded: false, reason: "gateway" });
      expect(await rowsOf(entry.itemId, "member-observed")).toHaveLength(0);
    });

    test("is judged against the latest version's endpoint, not an older install's", async () => {
      const entry = await item();
      const moved = `https://mcp2.${tag}.com/mcp`;
      await data.db.execute(sql`
        update mcp_server_versions
        set manifest_json = jsonb_set(manifest_json, '{endpointUrl}', to_jsonb(${moved}::text))
        where server_id = ${entry.itemId}`);
      expect(await observe(entry)).toEqual({ recorded: false, reason: "endpoint" });
    });

    test("a tool nested too deep drops the whole observation", async () => {
      const entry = await item();
      let deep: Record<string, unknown> = { type: "string" };
      for (let i = 0; i < 5_000; i++) deep = { items: deep };
      const result = await observe(entry, {
        tools: [
          { name: "ok", inputSchema: {} },
          { name: "deep", inputSchema: deep },
        ],
      });
      expect(result).toEqual({ recorded: false, reason: "invalid" });
      expect(await rowsOf(entry.itemId, "member-observed")).toHaveLength(0);
    });

    test("an unpublished listing takes no observation", async () => {
      const entry = await item();
      await data.db
        .update(data.mcpServers)
        .set({ status: "draft" })
        .where(eq(data.mcpServers.id, entry.itemId));
      expect(await observe(entry)).toEqual({ recorded: false, reason: "not-catalog" });
    });
  });

  describe("takedown", () => {
    test("removes a source's whole history, hides it, and keeps it from being recorded again until restored", async () => {
      const entry = await item();
      await observe(entry);
      await observe(entry, { tools: [{ name: "v2", inputSchema: {} }] });
      const takedown = await post("/v1/market/admin/mcp/tool-sources", {
        identifier: entry.identifier,
        source: "member-observed",
        action: "takedown",
      });
      expect(takedown.status).toBe(200);
      const rows = await rowsOf(entry.itemId, "member-observed");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ withdrawn: true, toolsJson: [], toolsCount: 0 });

      const page = await detail(entry.identifier);
      expect(page.toolsRevision).toBeNull();
      expect(page.versions[0]!.manifestJson.tools).toEqual([]);
      const history = await (await app.request(`/v1/mcp/${enc(entry.identifier)}/tools/revisions`)).json();
      expect(history).toMatchObject({ source: null, items: [] });

      expect(await observe(entry)).toEqual({ recorded: false, reason: "taken-down" });
      expect((await rowsOf(entry.itemId, "member-observed"))).toHaveLength(1);

      const restore = await post("/v1/market/admin/mcp/tool-sources", {
        identifier: entry.identifier,
        source: "member-observed",
        action: "restore",
      });
      expect(await restore.json()).toMatchObject({ changed: true });
      expect(await observe(entry)).toEqual({ recorded: true, outcome: "created" });
      expect(await rowsOf(entry.itemId, "member-observed")).toHaveLength(1);
    });

    test("the platform snapshot can be taken down too, and then refuses submissions", async () => {
      const { identifier, itemId } = await item();
      await submit(identifier);
      await post("/v1/market/admin/mcp/tool-sources", {
        identifier,
        source: "platform-indexed",
        action: "takedown",
      });
      expect((await detail(identifier)).toolsRevision).toBeNull();
      const refused = await submit(identifier);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "MCP_SNAPSHOT_SOURCE_TAKEN_DOWN" });
      await post("/v1/market/admin/mcp/tool-sources", { identifier, source: "platform-indexed", action: "restore" });
      expect((await submit(identifier)).status).toBe(201);
      expect(await rowsOf(itemId, "platform-indexed")).toHaveLength(1);
    });

    test("restoring a source that was not taken down changes nothing; the owner source cannot be taken down here", async () => {
      const entry = await item();
      await observe(entry);
      const restore = await post("/v1/market/admin/mcp/tool-sources", {
        identifier: entry.identifier,
        source: "member-observed",
        action: "restore",
      });
      expect(await restore.json()).toMatchObject({ changed: false });
      expect(await rowsOf(entry.itemId, "member-observed")).toHaveLength(1);
      const owner = await post("/v1/market/admin/mcp/tool-sources", {
        identifier: entry.identifier,
        source: "owner",
        action: "takedown",
      });
      expect(owner.status).toBe(400);
    });

    test("a takedown racing a recording is never overtaken", async () => {
      const entry = await item();
      await observe(entry);
      await Promise.all([
        revisions.takedownToolSource({ itemId: entry.itemId, source: "member-observed" }),
        ...Array.from({ length: 5 }, (_, index) =>
          observe(entry, { tools: [{ name: `racer${index}`, inputSchema: {} }] }),
        ),
      ]);
      const rows = await rowsOf(entry.itemId, "member-observed");
      // Whatever the order, the takedown stands: one marker, no list on top.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ withdrawn: true });
    });
  });
});
