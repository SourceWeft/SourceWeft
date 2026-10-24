import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
      expect(row?.expiresAt?.getTime()).toBeGreaterThan(Date.now());

      // Not published yet.
      let verify = await app.request(`/v1/market/mcp-claims/${claim.id}/verify`, { method: "POST" });
      expect(verify.status).toBe(409);
      expect((await json(verify)).code).toBe("MCP_CLAIM_TOKEN_NOT_FOUND");

      // Published at another name: still not found (exact record only).
      state.txt.set(`${tag}.com`, [[instructions.token]]);
      verify = await app.request(`/v1/market/mcp-claims/${claim.id}/verify`, { method: "POST" });
      expect((await json(verify)).code).toBe("MCP_CLAIM_TOKEN_NOT_FOUND");

      // DNS down: nothing is decided.
      state.lookupFailure = true;
      verify = await app.request(`/v1/market/mcp-claims/${claim.id}/verify`, { method: "POST" });
      expect(verify.status).toBe(503);
      expect((await json(verify)).code).toBe("MCP_CLAIM_LOOKUP_FAILED");
      state.lookupFailure = false;

      // Someone else cannot verify (or even see) carol's claim.
      state.userId = "dave";
      verify = await app.request(`/v1/market/mcp-claims/${claim.id}/verify`, { method: "POST" });
      expect(verify.status).toBe(404);
      state.userId = "carol";

      state.txt.set(`_sourceweft-claim.${tag}.com`, [["v=spf1 -all"], [instructions.token]]);
      verify = await app.request(`/v1/market/mcp-claims/${claim.id}/verify`, { method: "POST" });
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
      // In time, it verifies.
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
    test("list and revoke claims; a revoked owner loses write access", async () => {
      state.userId = "carol";
      expect((await app.request("/v1/market/admin/mcp/claims")).status).toBe(403);
      state.userId = "market-admin";
      const listed = (await json(
        await app.request(`/v1/market/admin/mcp/claims?identifier=${enc(DOMAIN_ID)}`),
      )) as unknown as { items: Array<Record<string, unknown>> };
      const carols = listed.items.find(
        (item) => item.userId === "carol" && item.status === "verified",
      );
      expect(carols).toMatchObject({ identifier: DOMAIN_ID, method: "dns_txt" });

      // Carol sets a logo again (the earlier test's last PUT replaced the
      // whole set), so the revocation has a correction to stop showing.
      state.userId = "carol";
      await app.request(`/v1/market/mcp/${enc(DOMAIN_ID)}/owner-overrides`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ iconUrl: `https://${tag}.com/logo.png` }),
      });
      state.userId = "market-admin";
      const revoked = await app.request(`/v1/market/admin/mcp/claims/${carols!.id}/revoke`, {
        method: "POST",
      });
      expect(revoked.status).toBe(200);
      expect((await json(revoked)).claim).toMatchObject({ status: "blocked" });

      state.userId = "carol";
      const refused = await app.request(`/v1/market/mcp/${enc(DOMAIN_ID)}/owner-overrides`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: "again" }),
      });
      expect(refused.status).toBe(403);
      // The block is sticky: carol cannot claim the server again, by any
      // method, until an admin lifts it.
      const reclaim = await app.request(`/v1/market/mcp/${enc(DOMAIN_ID)}/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "dns_txt" }),
      });
      expect(reclaim.status).toBe(403);
      expect((await json(reclaim)).code).toBe("MCP_CLAIM_BLOCKED");
      const seen = (await json(await app.request(`/v1/market/mcp/${enc(DOMAIN_ID)}/claim`))) as unknown as {
        viewerClaims: Array<{ status: string }>;
      };
      expect(seen.viewerClaims.map((claim) => claim.status)).toContain("blocked");
      // With no verified owner left, the mark goes and the corrections stop
      // applying (they stay stored for a future owner): the registry's own
      // data shows again.
      const detail = (await json(await app.request(`/v1/mcp/${enc(DOMAIN_ID)}`))) as {
        item: Record<string, unknown>;
      };
      expect(detail.item).toMatchObject({
        claimed: false,
        deprecated: false,
        owner: null,
        iconUrl: "https://registry.example/icon.png",
      });
      const [stored] = await data.db
        .select()
        .from(data.marketMcpOwnerOverrides)
        .innerJoin(data.mcpServers, eq(data.mcpServers.id, data.marketMcpOwnerOverrides.serverId))
        .where(eq(data.mcpServers.identifier, DOMAIN_ID));
      expect(stored?.market_mcp_owner_overrides.overridesJson).toMatchObject({
        iconUrl: `https://${tag}.com/logo.png`,
      });

      // Lifting the block lets carol claim again (a fresh pending claim).
      state.userId = "market-admin";
      const unblocked = await app.request(`/v1/market/admin/mcp/claims/${carols!.id}/unblock`, {
        method: "POST",
      });
      expect(unblocked.status).toBe(200);
      expect((await json(unblocked)).claim).toMatchObject({ status: "revoked" });
      state.userId = "carol";
      const again = await app.request(`/v1/market/mcp/${enc(DOMAIN_ID)}/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "dns_txt" }),
      });
      expect(again.status).toBe(201);
    });

    test("a correction shows only while its author holds a verified claim", async () => {
      const identifier = `com.${tag}two/mcp`;
      await ingest.upsertMarketMcp({ ...federated, manifest: manifest(identifier) });
      // Two verified owners; the second writes the corrections.
      for (const user of ["owner-a", "owner-b"]) {
        const started = await service.startMcpClaim(
          { userId: user, identifier, method: "well_known" },
          deps(),
        );
        state.wellKnown.set(
          `https://${tag}two.com/.well-known/sourceweft-claim`,
          started.instructions!.token,
        );
        await service.verifyMcpClaim({ userId: user, claimId: started.claim.id }, deps());
      }
      await service.setMcpOwnerOverrides(
        { userId: "owner-b", identifier, values: { summary: "B's summary" } },
        deps(),
      );
      const shown = async () =>
        ((await json(await app.request(`/v1/mcp/${enc(identifier)}`))) as { item: { summary: string; claimed: boolean } }).item;
      expect(await shown()).toMatchObject({ summary: "B's summary", claimed: true });

      // An admin revokes owner-b: the server stays claimed (owner-a), but
      // owner-b's corrections stop showing.
      const rows = await service.listMcpClaimsForAdmin({ identifier });
      const b = rows.find((row) => row.userId === "owner-b" && row.status === "verified")!;
      await service.adminRevokeMcpClaim({ adminUserId: "market-admin", claimId: b.id }, deps());
      expect(await shown()).toMatchObject({ summary: "Registry summary", claimed: true });
    });

    test("an owner can give up their own claim", async () => {
      state.userId = "erin";
      const identifier = `com.${tag}wk/mcp`;
      const overview = (await json(
        await app.request(`/v1/market/mcp/${enc(identifier)}/claim`),
      )) as unknown as { viewerClaims: Array<{ id: string; status: string }> };
      const verified = overview.viewerClaims.find((claim) => claim.status === "verified")!;
      const revoked = await app.request(`/v1/market/mcp-claims/${verified.id}/revoke`, {
        method: "POST",
      });
      expect(revoked.status).toBe(200);
      expect((await json(revoked)).claim).toMatchObject({ status: "revoked" });
      const after = (await json(
        await app.request(`/v1/market/mcp/${enc(identifier)}/claim`),
      )) as unknown as { claimed: boolean; claimedByYou: boolean };
      expect(after).toMatchObject({ claimed: false, claimedByYou: false });
    });
  });
});
