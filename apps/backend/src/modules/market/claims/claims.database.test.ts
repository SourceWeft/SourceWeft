import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  marketMcpManifestSchema,
  type MarketMcpManifest,
} from "@sourceweft/market-contracts";
import { createRouteTestApp } from "../../../test/hono";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";
import type { GitHubAccountFacts, LinkedGithubAccount, OrgMembershipAnswer } from "./github";

/**
 * Owner claims end to end (Issue #367, W7): the token lifecycle of a domain
 * claim, the GitHub account and organization checks, who may write
 * corrections, how they sit on top of the federated data and survive a
 * re-sync, and what the overview reads.
 */

const state = vi.hoisted(() => ({
  userId: null as string | null,
  // What the fake GitHub says.
  accounts: new Map<string, { id: string; login: string; type: "User" | "Organization" }>(),
  linked: new Map<string, { accountId: string; accessToken: string | null; scope: string | null }>(),
  membership: null as null | { state: string; role: string } | "scope" | "none",
  membershipCalls: [] as Array<{ org: string; token: string }>,
  // What the fake domain publishes.
  txt: new Map<string, string[][]>(),
  wellKnown: new Map<string, string>(),
  lookupFailure: false,
  now: new Date("2026-10-24T12:00:00.000Z"),
}));

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
vi.mock("./github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github")>()),
  fetchGitHubAccount: async (login: string): Promise<GitHubAccountFacts | null> =>
    state.accounts.get(login.toLowerCase()) ?? null,
  getLinkedGithubAccount: async (userId: string): Promise<LinkedGithubAccount | null> =>
    state.linked.get(userId) ?? null,
  fetchGitHubOrgMembership: async (
    org: string,
    token: string,
  ): Promise<OrgMembershipAnswer> => {
    state.membershipCalls.push({ org, token });
    if (state.membership === "scope") return { kind: "scope" };
    if (state.membership === "none" || !state.membership) return { kind: "not_member" };
    return { kind: "member", ...state.membership };
  },
}));
vi.mock("./domain-verify", async (importOriginal) => {
  const original = await importOriginal<typeof import("./domain-verify")>();
  const lookup: import("./domain-verify").DomainLookup = {
    resolveTxt: async (name) => {
      if (state.lookupFailure) {
        throw Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" });
      }
      const records = state.txt.get(name);
      if (!records) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
      return records;
    },
    openFetch: () => ({
      fetch: async (input: RequestInfo | URL) => {
        if (state.lookupFailure) throw new TypeError("fetch failed");
        const body = state.wellKnown.get(String(input));
        return body === undefined
          ? new Response("", { status: 404 })
          : new Response(body, { status: 200 });
      },
      close: async () => undefined,
    }),
  };
  return { ...original, defaultDomainLookup: lookup };
});

const tag = `clm${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const DOMAIN_ID = `com.${tag}/mcp`; // → domain `${tag}.com`
const USER_ID = `io.github.${tag}user/server`;
const ORG_ID = `io.github.${tag}org/server`;

function manifest(identifier: string, overrides: Partial<MarketMcpManifest> = {}) {
  return marketMcpManifestSchema.parse({
    schemaVersion: 1,
    identifier,
    version: "1.0.0",
    name: `${tag} ${identifier}`,
    summary: "Registry summary",
    description: "Registry description",
    transport: "streamable_http",
    endpointUrl: `https://mcp.${tag}.com/mcp`,
    iconUrl: "https://registry.example/icon.png",
    categories: ["developer-tools"],
    tools: [],
    ...overrides,
  });
}

const federated = {
  status: "published" as const,
  visibility: "public" as const,
  origin: "upstream" as const,
  source: "registry.test",
};

// Errors answer `{ code, message }` at the top level (api-response.ts).
const json = (response: Response) =>
  response.json() as Promise<Record<string, unknown> & { code?: string }>;
const enc = encodeURIComponent;

describe("MCP owner claims", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let data: typeof import("@sourceweft/db");
  let ingest: typeof import("../ingest/repository");
  let service: typeof import("./service");
  let overview: typeof import("../overview/repository");
  let overviewSource: typeof import("../overview/source");
  let app: Hono;
  const originalUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase("mcp_claims");
    process.env.DATABASE_URL = isolated.url;
    data = await import("@sourceweft/db");
    ingest = await import("../ingest/repository");
    service = await import("./service");
    // Route calls run on the same clock as the direct service calls.
    service.defaultMcpClaimDeps.now = () => state.now;
    overview = await import("../overview/repository");
    overviewSource = await import("../overview/source");
    const market = await import("../../../api/routes/market");
    const claims = await import("../../../api/routes/market-claims");
    app = createRouteTestApp((hono) => {
      market.registerMarketRoutes(hono);
      claims.registerMarketClaimRoutes(hono);
    });
    for (const identifier of [DOMAIN_ID, USER_ID, ORG_ID]) {
      await ingest.upsertMarketMcp({ ...federated, manifest: manifest(identifier) });
    }
    state.accounts.set(`${tag}user`, { id: "1001", login: `${tag}user`, type: "User" });
    state.accounts.set(`${tag}org`, { id: "2002", login: `${tag}org`, type: "Organization" });
  }, 120_000);

  afterAll(async () => {
    if (data) await data.closeDatabase();
    if (isolated) await isolated.close();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  beforeEach(() => {
    state.userId = null;
    state.lookupFailure = false;
    state.membership = null;
    state.membershipCalls = [];
  });

  const deps = () => ({
    ...service.defaultMcpClaimDeps,
    now: () => state.now,
  });
  const advance = (seconds: number) => {
    state.now = new Date(state.now.getTime() + seconds * 1000);
  };
  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** Claims `identifier` through its well-known file as `user`; returns the claim id. */
  async function becomeOwner(user: string, identifier: string, host: string) {
    const started = await service.startMcpClaim(
      { userId: user, identifier, method: "well_known" },
      deps(),
    );
    state.wellKnown.set(
      `https://${host}/.well-known/sourceweft-claim`,
      started.instructions!.token,
    );
    advance(31);
    await service.verifyMcpClaim({ userId: user, claimId: started.claim.id }, deps());
    return started.claim.id;
  }
  async function authorsOf(identifier: string) {
    const [row] = await data.db
      .select()
      .from(data.marketMcpOwnerOverrides)
      .innerJoin(data.mcpServers, eq(data.mcpServers.id, data.marketMcpOwnerOverrides.serverId))
      .where(eq(data.mcpServers.identifier, identifier));
    return row?.market_mcp_owner_overrides;
  }

  describe("GitHub method", () => {
    test("a personal namespace is claimed by the linked account that is that user", async () => {
      state.linked.set("alice", { accountId: "1001", accessToken: null, scope: null });
      state.linked.set("mallory", { accountId: "9999", accessToken: null, scope: null });

      await expect(
        service.startMcpClaim({ userId: "nobody", identifier: USER_ID, method: "github" }, deps()),
      ).rejects.toMatchObject({ code: "MCP_CLAIM_GITHUB_NOT_LINKED" });
      await expect(
        service.startMcpClaim({ userId: "mallory", identifier: USER_ID, method: "github" }, deps()),
      ).rejects.toMatchObject({ code: "MCP_CLAIM_GITHUB_ACCOUNT_MISMATCH", statusCode: 403 });

      const result = await service.startMcpClaim(
        { userId: "alice", identifier: USER_ID, method: "github" },
        deps(),
      );
      expect(result.instructions).toBeNull();
      expect(result.claim).toMatchObject({
        identifier: USER_ID,
        method: "github",
        status: "verified",
        target: `${tag}user`,
        verifiedAt: state.now.toISOString(),
      });
      // Claiming again answers with the same claim.
      const again = await service.startMcpClaim(
        { userId: "alice", identifier: USER_ID, method: "github" },
        deps(),
      );
      expect(again.claim.id).toBe(result.claim.id);
      expect(state.membershipCalls).toEqual([]);
    });

    test("an organization namespace needs the admin role, read with the member's own token", async () => {
      state.linked.set("bob", { accountId: "3003", accessToken: null, scope: "read:user" });
      await expect(
        service.startMcpClaim({ userId: "bob", identifier: ORG_ID, method: "github" }, deps()),
      ).rejects.toMatchObject({ code: "MCP_CLAIM_GITHUB_ORG_SCOPE" });

      state.linked.set("bob", { accountId: "3003", accessToken: "gho_bob", scope: "read:org" });
      state.membership = "scope";
      await expect(
        service.startMcpClaim({ userId: "bob", identifier: ORG_ID, method: "github" }, deps()),
      ).rejects.toMatchObject({ code: "MCP_CLAIM_GITHUB_ORG_SCOPE" });

      state.membership = { state: "active", role: "member" };
      await expect(
        service.startMcpClaim({ userId: "bob", identifier: ORG_ID, method: "github" }, deps()),
      ).rejects.toMatchObject({ code: "MCP_CLAIM_GITHUB_ORG_ROLE", statusCode: 403 });

      state.membership = { state: "active", role: "admin" };
      const result = await service.startMcpClaim(
        { userId: "bob", identifier: ORG_ID, method: "github" },
        deps(),
      );
      expect(result.claim.status).toBe("verified");
      expect(result.claim.target).toBe(`${tag}org`);
      // Every membership read carried bob's token, never anything else.
      expect(state.membershipCalls.every((call) => call.token === "gho_bob")).toBe(true);
      expect(state.membershipCalls.every((call) => call.org === `${tag}org`)).toBe(true);
    });

    test("a domain-namespace entry without a GitHub repository has no GitHub method", async () => {
      state.userId = "alice";
      const overview = await json(await app.request(`/v1/market/mcp/${enc(DOMAIN_ID)}/claim`));
      expect(overview).toMatchObject({
        identifier: DOMAIN_ID,
        claimed: false,
        claimedByYou: false,
        methods: {
          github: { available: false, owner: null, reason: "not_github_entry" },
          domain: { available: true, domain: `${tag}.com` },
        },
        overrides: null,
      });
      state.userId = "alice";
      await expect(
        service.startMcpClaim({ userId: "alice", identifier: DOMAIN_ID, method: "github" }, deps()),
      ).rejects.toMatchObject({ code: "MCP_CLAIM_METHOD_UNAVAILABLE" });
    });
  });

  describe("domain token lifecycle", () => {
    test("a DNS claim is pending until exactly that record carries the token", async () => {
      state.userId = "carol";
      const started = await app.request(`/v1/market/mcp/${enc(DOMAIN_ID)}/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "dns_txt" }),
      });
      expect(started.status).toBe(201);
      const { claim, instructions } = (await json(started)) as unknown as {
        claim: Record<string, unknown>;
        instructions: { token: string; dnsRecordName: string; dnsRecordValue: string; wellKnownUrl: string };
      };
      expect(claim).toMatchObject({ method: "dns_txt", status: "pending", target: `${tag}.com` });
      expect(instructions.dnsRecordName).toBe(`_sourceweft-claim.${tag}.com`);
      expect(instructions.wellKnownUrl).toBe(`https://${tag}.com/.well-known/sourceweft-claim`);
      expect(instructions.token).toMatch(/^sourceweft-claim-/);
      expect(instructions.dnsRecordValue).toBe(instructions.token);

      // Only the hash is stored.
      const [row] = await data.db
        .select()
        .from(data.marketMcpClaims)
        .where(eq(data.marketMcpClaims.id, claim.id as string));
      expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.tokenHash).not.toBe(instructions.token);
      expect(row?.expiresAt?.getTime()).toBe(state.now.getTime() + 7 * 86_400_000);

      // Not published yet.
      let verify = await (advance(31), post(`/v1/market/mcp-claims/${claim.id}/verify`));
      expect(verify.status).toBe(409);
      expect((await json(verify)).code).toBe("MCP_CLAIM_TOKEN_NOT_FOUND");

      // Published at another name: still not found (exact record only).
      state.txt.set(`${tag}.com`, [[instructions.token]]);
      verify = await (advance(31), post(`/v1/market/mcp-claims/${claim.id}/verify`));
      expect((await json(verify)).code).toBe("MCP_CLAIM_TOKEN_NOT_FOUND");

      // DNS down: nothing is decided.
      state.lookupFailure = true;
      verify = await (advance(31), post(`/v1/market/mcp-claims/${claim.id}/verify`));
      expect(verify.status).toBe(503);
      expect((await json(verify)).code).toBe("MCP_CLAIM_LOOKUP_FAILED");
      state.lookupFailure = false;

      // Someone else cannot verify (or even see) carol's claim.
      state.userId = "dave";
      verify = await (advance(31), post(`/v1/market/mcp-claims/${claim.id}/verify`));
      expect(verify.status).toBe(404);
      state.userId = "carol";

      state.txt.set(`_sourceweft-claim.${tag}.com`, [["v=spf1 -all"], [instructions.token]]);
      verify = await (advance(31), post(`/v1/market/mcp-claims/${claim.id}/verify`));
      expect(verify.status).toBe(200);
      expect((await json(verify)).claim).toMatchObject({ status: "verified", lastError: null });

      const overview = await json(await app.request(`/v1/market/mcp/${enc(DOMAIN_ID)}/claim`));
      expect(overview).toMatchObject({ claimed: true, claimedByYou: true });
      expect(overview.overrides).toMatchObject({ identifier: DOMAIN_ID, values: {}, tools: null });
    });

    test("a well-known claim reads the exact path, and an expired token is refused", async () => {
      const identifier = `com.${tag}wk/mcp`;
      await ingest.upsertMarketMcp({ ...federated, manifest: manifest(identifier) });
      const started = await service.startMcpClaim(
        { userId: "erin", identifier, method: "well_known" },
        deps(),
      );
      const token = started.instructions!.token;
      state.wellKnown.set(`https://${tag}wk.com/.well-known/sourceweft-claim`, `${token}\n`);

      // A second start replaces the pending claim; the old token is dead.
      const restarted = await service.startMcpClaim(
        { userId: "erin", identifier, method: "well_known" },
        deps(),
      );
      expect(restarted.claim.id).not.toBe(started.claim.id);
      await expect(
        service.verifyMcpClaim({ userId: "erin", claimId: started.claim.id }, deps()),
      ).rejects.toMatchObject({ code: "MCP_CLAIM_NOT_FOUND" });
      await expect(
        service.verifyMcpClaim({ userId: "erin", claimId: restarted.claim.id }, deps()),
      ).rejects.toMatchObject({ code: "MCP_CLAIM_TOKEN_NOT_FOUND" });

      state.wellKnown.set(
        `https://${tag}wk.com/.well-known/sourceweft-claim`,
        `${restarted.instructions!.token}\n`,
      );
      // Eight days later the token has expired.
      const late = { ...deps(), now: () => new Date(state.now.getTime() + 8 * 86_400_000) };
      await expect(
        service.verifyMcpClaim({ userId: "erin", claimId: restarted.claim.id }, late),
      ).rejects.toMatchObject({ code: "MCP_CLAIM_EXPIRED" });
      // In time, it verifies (30 s after the last attempt).
      advance(31);
      const verified = await service.verifyMcpClaim(
        { userId: "erin", claimId: restarted.claim.id },
        deps(),
      );
      expect(verified.claim.status).toBe("verified");
    });
  });

  describe("owner corrections", () => {
    const path = `/v1/market/mcp/${enc(DOMAIN_ID)}/owner-overrides`;
    const put = (body: unknown, suffix = "") =>
      app.request(`${path}${suffix}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    test("only a verified owner may read or write them", async () => {
      expect((await app.request(path)).status).toBe(401);
      state.userId = "dave";
      expect((await app.request(path)).status).toBe(403);
      const refused = await put({ summary: "Dave's summary" });
      expect(refused.status).toBe(403);
      expect((await json(refused)).code).toBe("MCP_CLAIM_REQUIRED");
      state.userId = "carol"; // verified above
      expect((await app.request(path)).status).toBe(200);
    });

    test("sit on top of the federated item and manifest and survive a re-sync", async () => {
      state.userId = "carol";
      const saved = await put({
        iconUrl: `https://${tag}.com/logo.png`,
        summary: "Owner summary",
        description: "Owner long description",
        documentationUrl: `https://docs.${tag}.com/mcp`,
        homepageUrl: `https://${tag}.com`,
        repoUrl: `https://github.com/${tag}/mcp`,
        deprecated: true,
      });
      expect(saved.status).toBe(200);
      expect((await json(saved)).values).toMatchObject({ summary: "Owner summary", deprecated: true });

      const submitted = await put(
        {
          tools: [
            { name: "search", description: "Search pages", inputSchema: { type: "object" } },
            { name: "delete_page", annotations: { destructiveHint: true } },
          ],
          generatedAt: "2026-10-24T10:00:00.000Z",
          serverInfo: { name: "demo", version: "1.0" },
        },
        "/tools",
      );
      expect(submitted.status).toBe(200);
      expect((await json(submitted)).tools).toMatchObject({ count: 2 });
      // Nothing about where the owner inspected is stored: hosted servers
      // carry secrets in their paths.
      const [overridesRow] = await data.db
        .select({ meta: data.marketMcpOwnerOverrides.toolsMetaJson })
        .from(data.marketMcpOwnerOverrides)
        .innerJoin(data.mcpServers, eq(data.mcpServers.id, data.marketMcpOwnerOverrides.serverId))
        .where(eq(data.mcpServers.identifier, DOMAIN_ID));
      expect(overridesRow?.meta).toEqual({
        generatedAt: "2026-10-24T10:00:00.000Z",
        serverInfo: { name: "demo", version: "1.0" },
      });

      const check = async () => {
        const detail = (await json(await app.request(`/v1/mcp/${enc(DOMAIN_ID)}`))) as {
          item: Record<string, unknown>;
          versions: Array<{ manifestJson: Record<string, unknown> }>;
        };
        expect(detail.item).toMatchObject({
          summary: "Owner summary",
          iconUrl: `https://${tag}.com/logo.png`,
          homepageUrl: `https://${tag}.com`,
          repoUrl: `https://github.com/${tag}/mcp`,
          toolsCount: 2,
          claimed: true,
          deprecated: true,
          owner: { source: "owner", documentationUrl: `https://docs.${tag}.com/mcp` },
        });
        expect(detail.versions[0]?.manifestJson).toMatchObject({
          description: "Owner long description",
          documentationUrl: `https://docs.${tag}.com/mcp`,
        });
        const served = (await json(await app.request(`/v1/mcp/${enc(DOMAIN_ID)}/manifest`))) as {
          manifest: MarketMcpManifest;
        };
        expect(served.manifest.description).toBe("Owner long description");
        expect(served.manifest.owner?.fields).toContain("tools");
        expect(served.manifest.tools.map((tool) => [tool.name, tool.risk, tool.source])).toEqual([
          ["search", "unknown", "owner-submitted"],
          ["delete_page", "unknown", "owner-submitted"],
        ]);
        // The registry's own facts are untouched.
        expect(served.manifest.endpointUrl).toBe(`https://mcp.${tag}.com/mcp`);
        const listed = (await json(await app.request(`/v1/mcp?query=${enc(DOMAIN_ID)}`))) as {
          items: Array<Record<string, unknown>>;
        };
        expect(listed.items.find((item) => item.identifier === DOMAIN_ID)).toMatchObject({
          summary: "Owner summary",
          claimed: true,
          deprecated: true,
          toolsCount: 2,
        });
      };
      await check();

      // Federation re-syncs the entry with new registry text: the owner's
      // layer still wins, and the stored registry data underneath moved.
      await ingest.upsertMarketMcp({
        ...federated,
        manifest: manifest(DOMAIN_ID, {
          summary: "Newer registry summary",
          description: "Newer registry description",
          tools: [{ name: "registry_tool", inputSchema: {}, annotations: {}, risk: "unknown" }],
        }),
      });
      const [server] = await data.db
        .select({ summary: data.mcpServers.summary })
        .from(data.mcpServers)
        .where(eq(data.mcpServers.identifier, DOMAIN_ID));
      expect(server?.summary).toBe("Newer registry summary");
      await check();

      // The overview reads the owner's description, tools and documentation.
      const [version] = await data.db
        .select({ id: data.mcpServerVersions.id, serverId: data.mcpServerVersions.serverId })
        .from(data.mcpServerVersions)
        .innerJoin(data.mcpServers, eq(data.mcpServers.id, data.mcpServerVersions.serverId))
        .where(eq(data.mcpServers.identifier, DOMAIN_ID));
      const row = await overview.findMcpOverviewSubjectRow(version!.id);
      expect(row?.ownerOverrides).toMatchObject({ overridesJson: { summary: "Owner summary" } });
      const source = overviewSource.mcpOverviewSource({ ...row!, readmeMd: null });
      expect(source?.registryDescription).toBe("Owner long description");
      expect(source?.manifest.documentationUrl).toBe(`https://docs.${tag}.com/mcp`);
      expect(source?.manifest.tools.map((tool) => tool.name)).toEqual(["search", "delete_page"]);
      const withOwner = overviewSource.mcpOverviewFingerprint({ ...row!, hasReadmeText: false });
      const withoutOwner = overviewSource.mcpOverviewFingerprint({
        ...row!,
        ownerOverrides: null,
        hasReadmeText: false,
      });
      expect(withOwner).not.toBe(withoutOwner);

      // Removing the tool list falls back to the registry's tools.
      const cleared = await app.request(`${path}/tools`, { method: "DELETE" });
      expect(cleared.status).toBe(200);
      expect((await json(cleared)).tools).toBeNull();
      const served = (await json(await app.request(`/v1/mcp/${enc(DOMAIN_ID)}/manifest`))) as {
        manifest: MarketMcpManifest;
      };
      expect(served.manifest.tools.map((tool) => tool.name)).toEqual(["registry_tool"]);
      // Clearing a field: null drops it, the registry value shows again.
      await put({ summary: null, deprecated: false });
      const detail = (await json(await app.request(`/v1/mcp/${enc(DOMAIN_ID)}`))) as {
        item: Record<string, unknown>;
      };
      expect(detail.item).toMatchObject({
        summary: "Newer registry summary",
        iconUrl: "https://registry.example/icon.png",
        deprecated: false,
        claimed: true,
      });
    });

    test("rejects bodies outside the contract", async () => {
      state.userId = "carol";
      expect((await put({ summary: "x".repeat(301) })).status).toBe(400);
      expect((await put({ iconUrl: "not a url" })).status).toBe(400);
      expect((await put({ unknownField: true })).status).toBe(400);
      expect((await put({ tools: "nope" }, "/tools")).status).toBe(400);
      // A direct request past the web form: only https links are accepted.
      for (const iconUrl of [
        "javascript:alert(1)",
        "data:text/html,hi",
        "http://insecure.example/logo.png",
        "https://user:secret@cdn.example/logo.png",
      ]) {
        const refused = await put({ iconUrl });
        expect(refused.status, iconUrl).toBe(400);
      }
      expect((await put({ documentationUrl: "javascript:void(0)" })).status).toBe(400);
      // The file's target (an endpoint or a command) is not part of the body.
      expect(
        (await put({ tools: [], target: { kind: "url", url: "https://x.example/mcp" } }, "/tools"))
          .status,
      ).toBe(400);
      // A tool's schemas are capped; so is the server's self-description.
      const huge = { type: "object", description: "x".repeat(33 * 1024) };
      expect((await put({ tools: [{ name: "big", inputSchema: huge }] }, "/tools")).status).toBe(400);
      expect(
        (await put({ tools: [], serverInfo: { blob: "y".repeat(5 * 1024) } }, "/tools")).status,
      ).toBe(400);
    });

    test("refuses an oversize body outright", async () => {
      state.userId = "carol";
      const refused = await app.request(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "x".repeat(70 * 1024) }),
      });
      expect(refused.status).toBe(413);
    });
  });

  describe("market admins", () => {
    test("revoking a claim blocks the member: no re-claim, no write, fields cleared", async () => {
      state.userId = "carol";
      expect((await app.request("/v1/market/admin/mcp/claims")).status).toBe(403);
      expect((await post("/v1/market/admin/mcp/blocks", { identifier: DOMAIN_ID, userId: "x" })).status).toBe(403);
      state.userId = "market-admin";
      const listed = (await json(
        await app.request(`/v1/market/admin/mcp/claims?identifier=${enc(DOMAIN_ID)}`),
      )) as unknown as { items: Array<Record<string, unknown>> };
      const carols = listed.items.find(
        (item) => item.userId === "carol" && item.status === "verified",
      );
      expect(carols).toMatchObject({ identifier: DOMAIN_ID, method: "dns_txt" });

      // Carol sets a logo (the earlier test's last PUT replaced the whole
      // set), so the block has something of hers to clear.
      state.userId = "carol";
      await app.request(`/v1/market/mcp/${enc(DOMAIN_ID)}/owner-overrides`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ iconUrl: `https://${tag}.com/logo.png` }),
      });
      expect((await authorsOf(DOMAIN_ID))?.authorsJson).toMatchObject({ iconUrl: "carol" });

      state.userId = "market-admin";
      const revoked = await post(`/v1/market/admin/mcp/claims/${carols!.id}/revoke`);
      expect(revoked.status).toBe(200);
      expect((await json(revoked)).claim).toMatchObject({ status: "revoked" });
      const blocks = (await json(
        await app.request(`/v1/market/admin/mcp/blocks?identifier=${enc(DOMAIN_ID)}`),
      )) as unknown as { items: Array<Record<string, unknown>> };
      expect(blocks.items).toEqual([
        expect.objectContaining({ identifier: DOMAIN_ID, userId: "carol", blockedBy: "market-admin" }),
      ]);

      state.userId = "carol";
      const refused = await app.request(`/v1/market/mcp/${enc(DOMAIN_ID)}/owner-overrides`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: "again" }),
      });
      expect(refused.status).toBe(403);
      // The block is sticky: no method gets carol back in until an admin lifts it.
      for (const method of ["dns_txt", "well_known", "github"]) {
        const reclaim = await post(`/v1/market/mcp/${enc(DOMAIN_ID)}/claims`, { method });
        expect(reclaim.status, method).toBe(403);
        expect((await json(reclaim)).code).toBe("MCP_CLAIM_BLOCKED");
      }
      const seen = (await json(await app.request(`/v1/market/mcp/${enc(DOMAIN_ID)}/claim`))) as unknown as {
        blocked: boolean;
      };
      expect(seen.blocked).toBe(true);
      // No verified owner is left: the mark goes and the registry's data
      // shows; what carol wrote is gone, not just hidden.
      const detail = (await json(await app.request(`/v1/mcp/${enc(DOMAIN_ID)}`))) as {
        item: Record<string, unknown>;
      };
      expect(detail.item).toMatchObject({
        claimed: false,
        deprecated: false,
        owner: null,
        iconUrl: "https://registry.example/icon.png",
      });
      const stored = await authorsOf(DOMAIN_ID);
      expect(stored?.overridesJson).toEqual({});
      expect(stored?.authorsJson).toEqual({});

      // Lifting the block lets carol claim again (a fresh pending claim).
      state.userId = "market-admin";
      const unblocked = await post("/v1/market/admin/mcp/blocks/unblock", {
        identifier: DOMAIN_ID,
        userId: "carol",
      });
      expect(await json(unblocked)).toMatchObject({ unblocked: true });
      state.userId = "carol";
      const again = await post(`/v1/market/mcp/${enc(DOMAIN_ID)}/claims`, { method: "dns_txt" });
      expect(again.status).toBe(201);
    });

    test("giving a claim up first does not shield a member from a block", async () => {
      const identifier = `com.${tag}shield/mcp`;
      const host = `${tag}shield.com`;
      await ingest.upsertMarketMcp({ ...federated, manifest: manifest(identifier) });
      const ginaClaim = await becomeOwner("gina", identifier, host);
      const hankClaim = await becomeOwner("hank", identifier, host);
      await service.setMcpOwnerOverrides(
        { userId: "gina", identifier, values: { summary: "Gina's summary" } },
        deps(),
      );
      // Both give their claims up before an admin acts.
      await service.revokeMcpClaim({ userId: "gina", claimId: ginaClaim }, deps());
      await service.revokeMcpClaim({ userId: "hank", claimId: hankClaim }, deps());

      // 1. A block by member and server needs no live claim row.
      state.userId = "market-admin";
      const blocked = await post("/v1/market/admin/mcp/blocks", { identifier, userId: "gina" });
      expect(blocked.status).toBe(201);
      expect((await json(blocked)).block).toMatchObject({ identifier, userId: "gina" });
      // 2. Revoking a claim that is already revoked still writes the block.
      const revoked = await post(`/v1/market/admin/mcp/claims/${hankClaim}/revoke`);
      expect(revoked.status).toBe(200);
      expect((await json(revoked)).claim).toMatchObject({ status: "revoked" });

      for (const user of ["gina", "hank"]) {
        await expect(
          service.startMcpClaim({ userId: user, identifier, method: "well_known" }, deps()),
        ).rejects.toMatchObject({ code: "MCP_CLAIM_BLOCKED", statusCode: 403 });
      }
      // What gina wrote is cleared although she had left.
      expect((await authorsOf(identifier))?.overridesJson).toEqual({});

      // Blocking twice keeps the first block; unblocking twice says so.
      await post("/v1/market/admin/mcp/blocks", { identifier, userId: "gina" });
      const list = (await json(
        await app.request(`/v1/market/admin/mcp/blocks?identifier=${enc(identifier)}`),
      )) as unknown as { items: unknown[] };
      expect(list.items).toHaveLength(2);
      const first = await post("/v1/market/admin/mcp/blocks/unblock", { identifier, userId: "gina" });
      expect(await json(first)).toMatchObject({ unblocked: true });
      const second = await post("/v1/market/admin/mcp/blocks/unblock", { identifier, userId: "gina" });
      expect(await json(second)).toMatchObject({ unblocked: false });
      expect((await post("/v1/market/admin/mcp/blocks", { identifier: "no/such", userId: "x" })).status).toBe(404);
    });

    test("a blocked member verifying any claim is told 403 blocked, and a pending sibling is ended", async () => {
      const identifier = `com.${tag}pend/mcp`;
      const host = `${tag}pend.com`;
      await ingest.upsertMarketMcp({ ...federated, manifest: manifest(identifier) });
      const claimId = await becomeOwner("frank", identifier, host);
      // A second, pending DNS claim beside the verified one, the way a race
      // leaves it (starting again would just return the verified claim).
      const repo = await import("./repository");
      const targets = await import("./targets");
      const token = targets.newClaimToken();
      const pending = await repo.replacePendingClaim({
        id: randomUUID(),
        serverId: (await repo.findClaimableServer(identifier))!.id,
        userId: "frank",
        method: "dns_txt",
        status: "pending",
        target: host,
        tokenHash: targets.hashClaimToken(token),
        expiresAt: new Date(state.now.getTime() + 86_400_000),
        createdAt: state.now,
      });
      state.txt.set(`_sourceweft-claim.${host}`, [[token]]);

      await service.adminRevokeMcpClaim({ adminUserId: "market-admin", claimId }, deps());

      // The sibling ended with the block ...
      const after = await service.listMcpClaimsForAdmin({ identifier });
      expect(after.filter((row) => row.userId === "frank").map((row) => row.status)).toEqual(
        expect.not.arrayContaining(["pending", "verified"]),
      );
      // ... and verifying it is 403 blocked — not the 409 "not pending" a
      // member with an ended claim would otherwise get.
      advance(31);
      await expect(
        service.verifyMcpClaim({ userId: "frank", claimId: pending.id }, deps()),
      ).rejects.toMatchObject({ code: "MCP_CLAIM_BLOCKED", statusCode: 403 });
      // Even a pending row that somehow survived cannot be finished.
      await data.db
        .update(data.marketMcpClaims)
        .set({ status: "pending", revokedAt: null, revokedBy: null })
        .where(eq(data.marketMcpClaims.id, pending.id));
      advance(31);
      await expect(
        service.verifyMcpClaim({ userId: "frank", claimId: pending.id }, deps()),
      ).rejects.toMatchObject({ code: "MCP_CLAIM_BLOCKED", statusCode: 403 });
      const detail = (await json(await app.request(`/v1/mcp/${enc(identifier)}`))) as {
        item: { claimed: boolean };
      };
      expect(detail.item.claimed).toBe(false);
    });

    test("tool lists make revisions: a new one per difference, a withdrawal for clearing or a block", async () => {
      const identifier = `com.${tag}rev/mcp`;
      const host = `${tag}rev.com`;
      await ingest.upsertMarketMcp({ ...federated, manifest: manifest(identifier) });
      await becomeOwner("rev-a", identifier, host);
      const tool = (name: string, description = "") => ({
        name,
        description,
        inputSchema: {},
        annotations: {},
      });
      const submit = (tools: ReturnType<typeof tool>[], serverInfo?: Record<string, unknown>) =>
        service.setMcpOwnerTools(
          { userId: "rev-a", identifier, submission: { tools, ...(serverInfo ? { serverInfo } : {}) } },
          deps(),
        );
      const history = async () => {
        const response = await app.request(`/v1/mcp/${enc(identifier)}/tools/revisions`);
        expect(response.status).toBe(200);
        return (await json(response)) as unknown as {
          source: string | null;
          items: Array<{
            revision: number;
            current: boolean;
            withdrawn: boolean;
            serverVersion: string | null;
            added: string[];
            removed: string[];
            changed: Array<{ name: string; fields: string[] }>;
          }>;
        };
      };
      const detailRevision = async () =>
        ((await json(await app.request(`/v1/mcp/${enc(identifier)}`))) as unknown as {
          toolsRevision: { source: string; revision: number } | null;
        }).toolsRevision;

      expect(await detailRevision()).toBeNull();
      await submit([tool("a"), tool("b")], { name: "srv", version: "1.4.0" });
      expect(await detailRevision()).toMatchObject({ source: "owner", revision: 1 });
      // The same list again (reordered, whitespace changed) is not a revision.
      advance(60);
      await submit([tool("b"), tool("a")], { name: "srv", version: "1.4.1" });
      expect(await detailRevision()).toMatchObject({ source: "owner", revision: 1 });
      await submit([tool("a", "now described"), tool("c")]);
      expect(await detailRevision()).toMatchObject({ source: "owner", revision: 2 });

      let page = await history();
      expect(page.source).toBe("owner");
      expect(page.items.map((item) => [item.revision, item.current])).toEqual([
        [2, true],
        [1, false],
      ]);
      expect(page.items[0]).toMatchObject({
        added: ["c"],
        removed: ["b"],
        changed: [{ name: "a", fields: ["description"] }],
      });
      expect(page.items[1]).toMatchObject({ added: ["a", "b"], serverVersion: "1.4.0" });

      // Clearing is a withdrawal, not an empty list; the detail has no revision to show.
      state.userId = "rev-a";
      const cleared = await app.request(`/v1/market/mcp/${enc(identifier)}/owner-overrides/tools`, {
        method: "DELETE",
      });
      expect(cleared.status).toBe(200);
      expect(await detailRevision()).toBeNull();
      // Nothing is public once the owner's list is no longer shown.
      expect((await history()).items).toEqual([]);
      // Publishing again continues the numbering against the empty list.
      await submit([tool("a", "now described"), tool("c")]);
      page = await history();
      expect(page.items.map((item) => [item.revision, item.withdrawn])).toEqual([
        [4, false],
        [3, true],
        [2, false],
        [1, false],
      ]);
      expect(page.items[0]).toMatchObject({ added: ["a", "c"], removed: [] });

      // A block clears the blocked member's list and, in the same step, the
      // history of it.
      await service.adminBlockMcpMember(
        { adminUserId: "market-admin", identifier, userId: "rev-a" },
        deps(),
      );
      const rows = await data.db
        .select({ revision: data.marketMcpToolRevisions.revision })
        .from(data.marketMcpToolRevisions)
        .innerJoin(data.mcpServers, eq(data.mcpServers.id, data.marketMcpToolRevisions.itemId))
        .where(eq(data.mcpServers.identifier, identifier));
      expect(rows).toEqual([]);
      // No member or team identifier anywhere in the table.
      expect(Object.keys(data.marketMcpToolRevisions).join(" ")).not.toMatch(/user|member|team/i);
    });

    test("a shown owner list is the only history: no fallback, no other source, nothing of a blocked member's", async () => {
      const identifier = `com.${tag}hist/mcp`;
      const host = `${tag}hist.com`;
      await ingest.upsertMarketMcp({ ...federated, manifest: manifest(identifier) });
      const toolRevisions = await import("../tool-revisions");
      const [server] = await data.db
        .select({ id: data.mcpServers.id })
        .from(data.mcpServers)
        .where(eq(data.mcpServers.identifier, identifier));
      const itemId = server!.id;
      const tool = (name: string) => ({ name, inputSchema: {}, annotations: {} });
      const submit = (userId: string, tools: ReturnType<typeof tool>[]) =>
        service.setMcpOwnerTools({ userId, identifier, submission: { tools } }, deps());
      const history = async (query = "") =>
        (await json(await app.request(`/v1/mcp/${enc(identifier)}/tools/revisions${query}`))) as unknown as {
          source: string | null;
          items: Array<{ revision: number; added: string[]; withdrawn: boolean }>;
        };
      const detailRevision = async () =>
        ((await json(await app.request(`/v1/mcp/${enc(identifier)}`))) as unknown as {
          toolsRevision: { source: string; revision: number } | null;
        }).toolsRevision;

      // The platform's snapshot is what shows while no owner list does.
      await toolRevisions.recordToolRevision({ itemId, source: "platform-indexed", tools: [tool("platform_tool")] });
      expect(await detailRevision()).toMatchObject({ source: "platform-indexed", revision: 1 });

      // An owner list stored before revisions existed: the page shows it, so
      // the platform's history must not stand in for it.
      await becomeOwner("hist-a", identifier, host);
      await submit("hist-a", [tool("a_secret_one")]);
      await data.db
        .delete(data.marketMcpToolRevisions)
        .where(eq(data.marketMcpToolRevisions.itemId, itemId));
      await toolRevisions.recordToolRevision({ itemId, source: "platform-indexed", tools: [tool("platform_tool")] });
      expect(await detailRevision()).toBeNull();
      expect(await history()).toEqual({ source: null, items: [], nextBefore: null });

      // With owner revisions it is the owner's, whatever `source` asks for.
      await submit("hist-a", [tool("a_secret_one"), tool("a_secret_two")]);
      for (const query of ["", "?source=platform-indexed", "?source=member-observed"]) {
        const page = await history(query);
        expect(page.source).toBe("owner");
        expect(page.items.map((entry) => entry.added)).toEqual([["a_secret_one", "a_secret_two"]]);
      }
      expect(await detailRevision()).toMatchObject({ source: "owner", revision: 1 });
      await submit("hist-a", [tool("a_secret_one")]);
      expect((await history()).items).toHaveLength(2);

      // An empty submission clears the list: a withdrawal, not an empty list.
      await submit("hist-a", []);
      expect(await detailRevision()).toMatchObject({ source: "platform-indexed" });
      const rows = async () =>
        data.db
          .select({ revision: data.marketMcpToolRevisions.revision, withdrawn: data.marketMcpToolRevisions.withdrawn })
          .from(data.marketMcpToolRevisions)
          .where(
            and(
              eq(data.marketMcpToolRevisions.itemId, itemId),
              eq(data.marketMcpToolRevisions.source, "owner"),
            ),
          )
          .orderBy(asc(data.marketMcpToolRevisions.revision));
      expect((await rows()).map((row) => row.withdrawn)).toEqual([false, false, true]);

      // A blocked member's earlier revisions do not outlive the block, even
      // when another owner then submits a list of their own.
      await submit("hist-a", [tool("a_secret_three")]);
      await becomeOwner("hist-b", identifier, host);
      await service.adminBlockMcpMember(
        { adminUserId: "market-admin", identifier, userId: "hist-a" },
        deps(),
      );
      expect(await rows()).toEqual([]);
      await submit("hist-b", [tool("b_tool")]);
      const after = await history();
      expect(after.items).toEqual([expect.objectContaining({ revision: 1, added: ["b_tool"] })]);
      expect(JSON.stringify(after)).not.toContain("a_secret");
    });

    test("fields keep their authors: blocking one owner clears theirs and keeps the other's", async () => {
      const identifier = `com.${tag}auth/mcp`;
      const host = `${tag}auth.com`;
      await ingest.upsertMarketMcp({ ...federated, manifest: manifest(identifier) });
      await becomeOwner("auth-a", identifier, host);
      await becomeOwner("auth-b", identifier, host);

      await service.setMcpOwnerOverrides(
        { userId: "auth-a", identifier, values: { iconUrl: "https://a.example/a.png" } },
        deps(),
      );
      // B's form shows A's logo; B saves it unchanged beside a summary of their own.
      const bForm = await service.getMcpOwnerOverrides({ userId: "auth-b", identifier });
      expect(bForm.values).toMatchObject({ iconUrl: "https://a.example/a.png" });
      await service.setMcpOwnerOverrides(
        { userId: "auth-b", identifier, values: { ...bForm.values, summary: "B summary" } },
        deps(),
      );
      await service.setMcpOwnerTools(
        {
          userId: "auth-b",
          identifier,
          submission: { tools: [{ name: "b_tool", inputSchema: {}, annotations: {} }] },
        },
        deps(),
      );
      expect((await authorsOf(identifier))?.authorsJson).toEqual({
        iconUrl: "auth-a",
        summary: "auth-b",
        tools: "auth-b",
      });
      const shown = async () =>
        (await json(await app.request(`/v1/mcp/${enc(identifier)}`))) as unknown as {
          item: { summary: string; iconUrl: string; toolsCount: number; claimed: boolean };
        };
      expect((await shown()).item).toMatchObject({
        summary: "B summary",
        iconUrl: "https://a.example/a.png",
        toolsCount: 1,
        claimed: true,
      });

      // Blocking B clears B's summary and tool list; A's logo stays.
      await service.adminBlockMcpMember(
        { adminUserId: "market-admin", identifier, userId: "auth-b" },
        deps(),
      );
      const stored = await authorsOf(identifier);
      expect(stored?.overridesJson).toEqual({ iconUrl: "https://a.example/a.png" });
      expect(stored?.authorsJson).toEqual({ iconUrl: "auth-a" });
      expect(stored?.toolsJson).toBeNull();
      expect((await shown()).item).toMatchObject({
        summary: "Registry summary",
        iconUrl: "https://a.example/a.png",
        toolsCount: 0,
        claimed: true,
      });

      // A saves later: nothing of B's comes back under A's name.
      const aForm = await service.getMcpOwnerOverrides({ userId: "auth-a", identifier });
      await service.setMcpOwnerOverrides(
        { userId: "auth-a", identifier, values: { ...aForm.values, description: "A description" } },
        deps(),
      );
      expect((await shown()).item).toMatchObject({ summary: "Registry summary", toolsCount: 0 });
      expect((await authorsOf(identifier))?.toolsJson).toBeNull();
      const served = (await json(await app.request(`/v1/mcp/${enc(identifier)}/manifest`))) as unknown as {
        manifest: MarketMcpManifest;
      };
      expect(served.manifest.description).toBe("A description");
      expect(served.manifest.tools).toEqual([]);
    });

    test("a member who left keeps their work hidden, not taken over; claiming again brings it back", async () => {
      const identifier = `com.${tag}quar/mcp`;
      const host = `${tag}quar.com`;
      await ingest.upsertMarketMcp({ ...federated, manifest: manifest(identifier) });
      await becomeOwner("quar-a", identifier, host);
      const cClaim = await becomeOwner("quar-c", identifier, host);
      await service.setMcpOwnerOverrides(
        { userId: "quar-c", identifier, values: { documentationUrl: "https://docs.example/c" } },
        deps(),
      );
      const shownDocs = async () =>
        (
          (await json(await app.request(`/v1/mcp/${enc(identifier)}/manifest`))) as unknown as {
            manifest: MarketMcpManifest;
          }
        ).manifest.documentationUrl;
      expect(await shownDocs()).toBe("https://docs.example/c");

      await service.revokeMcpClaim({ userId: "quar-c", claimId: cClaim }, deps());
      expect(await shownDocs()).toBeUndefined();
      // A saves something else: C's hidden field survives the save untouched.
      await service.setMcpOwnerOverrides(
        { userId: "quar-a", identifier, values: { summary: "A summary" } },
        deps(),
      );
      expect((await authorsOf(identifier))?.authorsJson).toEqual({
        documentationUrl: "quar-c",
        summary: "quar-a",
      });
      expect(await shownDocs()).toBeUndefined();
      // A writing that same link themselves makes it theirs, and visible.
      await service.setMcpOwnerOverrides(
        {
          userId: "quar-a",
          identifier,
          values: { summary: "A summary", documentationUrl: "https://docs.example/c" },
        },
        deps(),
      );
      expect((await authorsOf(identifier))?.authorsJson).toEqual({
        documentationUrl: "quar-a",
        summary: "quar-a",
      });
      expect(await shownDocs()).toBe("https://docs.example/c");
    });

    test("an owner can give up their own claim", async () => {
      state.userId = "erin";
      const identifier = `com.${tag}wk/mcp`;
      const overview = (await json(
        await app.request(`/v1/market/mcp/${enc(identifier)}/claim`),
      )) as unknown as { viewerClaims: Array<{ id: string; status: string }> };
      const verified = overview.viewerClaims.find((claim) => claim.status === "verified")!;
      const revoked = await post(`/v1/market/mcp-claims/${verified.id}/revoke`);
      expect(revoked.status).toBe(200);
      expect((await json(revoked)).claim).toMatchObject({ status: "revoked" });
      const after = (await json(
        await app.request(`/v1/market/mcp/${enc(identifier)}/claim`),
      )) as unknown as { claimed: boolean; claimedByYou: boolean; blocked: boolean };
      expect(after).toMatchObject({ claimed: false, claimedByYou: false, blocked: false });
    });
  });

  describe("a block that lands while a claim is being decided", () => {
    test("during the GitHub lookup: no verified claim is written", async () => {
      state.linked.set("race-g", { accountId: "1001", accessToken: null, scope: null });
      const blockingDeps = {
        ...deps(),
        github: {
          ...service.defaultMcpClaimDeps.github,
          fetchAccount: async (login: string) => {
            // The admin's block commits while GitHub is being asked.
            await service.adminBlockMcpMember(
              { adminUserId: "market-admin", identifier: USER_ID, userId: "race-g" },
              deps(),
            );
            return state.accounts.get(login.toLowerCase()) ?? null;
          },
        },
      };
      await expect(
        service.startMcpClaim(
          { userId: "race-g", identifier: USER_ID, method: "github" },
          blockingDeps,
        ),
      ).rejects.toMatchObject({ code: "MCP_CLAIM_BLOCKED", statusCode: 403 });
      const claims = await data.db
        .select()
        .from(data.marketMcpClaims)
        .where(eq(data.marketMcpClaims.userId, "race-g"));
      expect(claims.filter((claim) => claim.status === "verified")).toEqual([]);
    });

    test("during the publisher lookup: the pending claim is not verified", async () => {
      const identifier = `com.${tag}racing/mcp`;
      const host = `${tag}racing.com`;
      await ingest.upsertMarketMcp({ ...federated, manifest: manifest(identifier) });
      const started = await service.startMcpClaim(
        { userId: "race-d", identifier, method: "well_known" },
        deps(),
      );
      advance(31);
      const blockingDeps = {
        ...deps(),
        domain: {
          ...service.defaultMcpClaimDeps.domain,
          openFetch: () => ({
            fetch: (async () => {
              // The token is there, and the block commits during the fetch.
              await service.adminBlockMcpMember(
                { adminUserId: "market-admin", identifier, userId: "race-d" },
                deps(),
              );
              return new Response(started.instructions!.token, { status: 200 });
            }) as typeof globalThis.fetch,
            close: async () => undefined,
          }),
        },
      };
      await expect(
        service.verifyMcpClaim({ userId: "race-d", claimId: started.claim.id }, blockingDeps),
      ).rejects.toMatchObject({ code: "MCP_CLAIM_BLOCKED", statusCode: 403 });
      const claims = await data.db
        .select()
        .from(data.marketMcpClaims)
        .where(eq(data.marketMcpClaims.userId, "race-d"));
      expect(claims.filter((claim) => claim.status === "verified")).toEqual([]);
      void host;
    });

    test("a save racing a block leaves nothing of the blocked member's behind", async () => {
      const identifier = `com.${tag}race/mcp`;
      const host = `${tag}race.com`;
      await ingest.upsertMarketMcp({ ...federated, manifest: manifest(identifier) });
      for (let round = 0; round < 6; round += 1) {
        const user = `save-${round}`;
        await becomeOwner(user, identifier, host);
        const outcomes = await Promise.allSettled([
          service.setMcpOwnerOverrides(
            { userId: user, identifier, values: { summary: `from ${user}` } },
            deps(),
          ),
          service.setMcpOwnerTools(
            {
              userId: user,
              identifier,
              submission: { tools: [{ name: `tool_${round}`, inputSchema: {}, annotations: {} }] },
            },
            deps(),
          ),
          service.adminBlockMcpMember(
            { adminUserId: "market-admin", identifier, userId: user },
            deps(),
          ),
        ]);
        // The block always succeeds; a save either ran first (and was
        // cleared) or lost to the block (and was refused).
        expect(outcomes[2]?.status).toBe("fulfilled");
        for (const save of outcomes.slice(0, 2)) {
          if (save.status === "rejected") {
            expect(["MCP_CLAIM_BLOCKED", "MCP_CLAIM_REQUIRED"]).toContain(
              (save.reason as { code: string }).code,
            );
          }
        }
        const stored = await authorsOf(identifier);
        expect(Object.values(stored?.authorsJson ?? {})).not.toContain(user);
        expect(JSON.stringify(stored?.overridesJson ?? {})).not.toContain(`from ${user}`);
        expect(JSON.stringify(stored?.toolsJson ?? null)).not.toContain(`tool_${round}`);
      }
    });
  });

  describe("throttle", () => {
    test("verify: one attempt per member and server every 30 seconds, with a stable 429", async () => {
      const identifier = `com.${tag}thr/mcp`;
      await ingest.upsertMarketMcp({ ...federated, manifest: manifest(identifier) });
      state.userId = "tess";
      const started = await post(`/v1/market/mcp/${enc(identifier)}/claims`, { method: "dns_txt" });
      expect(started.status).toBe(201);
      const claimId = ((await json(started)).claim as { id: string }).id;
      const verify = () => post(`/v1/market/mcp-claims/${claimId}/verify`);

      expect((await verify()).status).toBe(409); // token not published: a real attempt
      advance(10);
      const limited = await verify();
      expect(limited.status).toBe(429);
      const body = await json(limited);
      expect(body.code).toBe("MCP_CLAIM_RATE_LIMITED");
      expect(body.details).toEqual({ retryAfterSeconds: 20, reason: "interval" });
      // The refused attempt did not use the budget or move the clock on.
      advance(20);
      expect((await verify()).status).toBe(409);
      // Another member is not held up by tess.
      state.userId = "tess-two";
      expect(
        (await post(`/v1/market/mcp/${enc(identifier)}/claims`, { method: "dns_txt" })).status,
      ).toBe(201);
    });

    test("start: ten attempts per member per hour, GitHub mismatches included", async () => {
      // Each failed GitHub start asks GitHub who owns the account, so it is
      // an attempt like any other.
      state.linked.set("vera", { accountId: "9999", accessToken: null, scope: null });
      const start = () =>
        service.startMcpClaim({ userId: "vera", identifier: USER_ID, method: "github" }, deps());
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await expect(start()).rejects.toMatchObject({ code: "MCP_CLAIM_GITHUB_ACCOUNT_MISMATCH" });
      }
      await expect(start()).rejects.toMatchObject({
        code: "MCP_CLAIM_RATE_LIMITED",
        statusCode: 429,
        details: { reason: "hourly", retryAfterSeconds: 3600 },
      });
      // The oldest attempt leaves the window after an hour.
      advance(3601);
      await expect(start()).rejects.toMatchObject({ code: "MCP_CLAIM_GITHUB_ACCOUNT_MISMATCH" });
      // Attempts older than a day are dropped as the member passes.
      advance(25 * 3600);
      await expect(start()).rejects.toMatchObject({ code: "MCP_CLAIM_GITHUB_ACCOUNT_MISMATCH" });
      const rows = await data.db
        .select()
        .from(data.marketMcpClaimAttempts)
        .where(eq(data.marketMcpClaimAttempts.userId, "vera"));
      expect(rows).toHaveLength(1);
    });

    test("a burst of parallel verifies gets one through, whatever order their clocks and locks fall in", async () => {
      const identifier = `com.${tag}burst/mcp`;
      await ingest.upsertMarketMcp({ ...federated, manifest: manifest(identifier) });
      const started = await service.startMcpClaim(
        { userId: "burst", identifier, method: "dns_txt" },
        deps(),
      );
      advance(31);
      // Each request took its timestamp before queueing for the member's
      // lock, some earlier and some later than the others.
      const offsets = [0, -3, 2, -1, 4, 1, -2];
      const outcomes = await Promise.allSettled(
        offsets.map((offset) =>
          service.verifyMcpClaim(
            { userId: "burst", claimId: started.claim.id },
            { ...deps(), now: () => new Date(state.now.getTime() + offset * 1000) },
          ),
        ),
      );
      const codes = outcomes.map((outcome) =>
        outcome.status === "rejected" ? (outcome.reason as { code: string }).code : "ok",
      );
      // The one that got through looked the token up (and did not find it).
      expect(codes.filter((code) => code === "MCP_CLAIM_TOKEN_NOT_FOUND")).toHaveLength(1);
      expect(codes.filter((code) => code === "MCP_CLAIM_RATE_LIMITED")).toHaveLength(
        offsets.length - 1,
      );
      const rows = await data.db
        .select()
        .from(data.marketMcpClaimAttempts)
        .where(eq(data.marketMcpClaimAttempts.userId, "burst"));
      expect(rows.filter((row) => row.kind === "verify")).toHaveLength(1);
    });

    test("a method that cannot work spends no attempt", async () => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await expect(
          service.startMcpClaim({ userId: "wendy", identifier: DOMAIN_ID, method: "github" }, deps()),
        ).rejects.toMatchObject({ code: "MCP_CLAIM_METHOD_UNAVAILABLE" });
      }
    });
  });
});
