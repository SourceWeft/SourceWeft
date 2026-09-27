import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  marketMcpManifestSchema,
  type MarketMcpManifest,
} from "@sourceweft/market-contracts";
import { createRouteTestApp } from "../../../test/hono";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";
import type { GitHubReadmeResult } from "./github-readme";

const state = vi.hoisted(() => ({
  userId: null as string | null,
  parse: vi.fn(),
  enqueue: vi.fn(),
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
vi.mock("../parse-repository", () => ({ parseMcpRepository: state.parse }));
// The queue is Redis; what is queued is checked here, the worker side runs
// the batch directly below.
vi.mock("./readme-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./readme-queue")>()),
  enqueueMcpReadmeFetch: state.enqueue,
  readLastMcpReadmeBatch: async () => null,
}));

const COMMIT = "c0ffee".padEnd(40, "0");
const DAY = 24 * 60 * 60 * 1000;
const tag = `rd${randomUUID().replaceAll("-", "").slice(0, 12)}`;

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

const federated: {
  status: "published" | "reviewing";
  visibility: "public" | "private";
  origin: "upstream" | "submitted";
  source: string;
} = {
  status: "published",
  visibility: "public",
  origin: "upstream",
  source: "registry.test",
};

describe("MCP README storage and fetch state", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let data: typeof import("@sourceweft/db");
  let ingest: typeof import("../ingest/repository");
  let plan: typeof import("../ingest/plan");
  let readmes: typeof import("./readme-repository");
  let fetching: typeof import("./readme-fetch");
  let app: Hono;
  const originalUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase("mcp_readme");
    process.env.DATABASE_URL = isolated.url;
    data = await import("@sourceweft/db");
    ingest = await import("../ingest/repository");
    plan = await import("../ingest/plan");
    readmes = await import("./readme-repository");
    fetching = await import("./readme-fetch");
    const routes = await import("../../../api/routes/market");
    app = createRouteTestApp(routes.registerMarketRoutes);
  }, 120_000);

  afterAll(async () => {
    if (data) await data.closeDatabase();
    if (isolated) await isolated.close();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  async function versionRow(identifier: string, version = "1.0.0") {
    const [row] = await data.db
      .select()
      .from(data.mcpServerVersions)
      .where(
        eq(
          data.mcpServerVersions.id,
          plan.mcpServerVersionId(identifier, version),
        ),
      );
    return row!;
  }

  const readmeColumns = (row: Awaited<ReturnType<typeof versionRow>>) => ({
    readmeMd: row.readmeMd,
    readmePath: row.readmePath,
    readmeRef: row.readmeRef,
    readmeSha256: row.readmeSha256,
    readmeStatus: row.readmeStatus,
    readmeEtag: row.readmeEtag,
    readmeFetchedAt: row.readmeFetchedAt,
    readmeNextFetchAt: row.readmeNextFetchAt,
    readmeAttempts: row.readmeAttempts,
    readmeError: row.readmeError,
  });

  test("a new version starts pending and due; a re-sync never touches a stored README", async () => {
    const weather = manifest("weather");
    const before = Date.now();
    await ingest.upsertMarketMcp({ ...federated, manifest: weather });
    const fresh = await versionRow(weather.identifier);
    expect(fresh.readmeStatus).toBe("pending");
    expect(fresh.readmeAttempts).toBe(0);
    expect(fresh.readmeMd).toBeNull();
    expect(fresh.readmeNextFetchAt!.getTime()).toBeGreaterThanOrEqual(
      before - 5_000,
    );
    expect(fresh.readmeNextFetchAt!.getTime()).toBeLessThanOrEqual(Date.now());

    await readmes.writeMcpReadmeColumns(fresh.id, {
      readmeStatus: "ok",
      readmeMd: "# Weather",
      readmePath: "README.md",
      readmeRef: COMMIT,
      readmeSha256: "a".repeat(64),
      readmeEtag: '"etag"',
      readmeFetchedAt: new Date(),
      readmeNextFetchAt: new Date(Date.now() + 7 * DAY),
      readmeAttempts: 0,
      readmeError: null,
    });
    const stored = readmeColumns(await versionRow(weather.identifier));

    // Federation re-syncs the same version with new metadata, and a
    // submission-shaped upsert lands on it too: neither touches the README.
    await ingest.upsertMarketMcp({
      ...federated,
      origin: "submitted",
      manifest: weather,
    });
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: { ...weather, summary: "Changed upstream", description: "New" },
      provenanceJson: {
        source: "registry.test",
        repository: { subfolder: "x" },
      },
    });
    const after = await versionRow(weather.identifier);
    expect(readmeColumns(after)).toEqual(stored);
    expect(after.provenanceJson).toEqual({
      source: "registry.test",
      repository: { subfolder: "x" },
    });
  });

  test("a submission stores the README its parse read", async () => {
    const submitted = manifest("submitted", { version: "0.3.0" });
    const bytes = Buffer.from("# Submitted\n\nSee [docs](docs/setup.md).\n");
    state.parse.mockResolvedValue({
      manifest: submitted,
      report: {
        installCommands: [],
        connections: [],
        github: {
          owner: tag,
          repo: "submitted",
          ref: COMMIT,
          commitSha: COMMIT,
          repoUrl: `https://github.com/${tag}/submitted`,
          sourceUrl: `https://github.com/${tag}/submitted`,
          subpath: "",
        },
      },
      readme: { path: "README.md", bytes },
    });
    state.userId = "submitter";
    const before = Date.now();
    const response = await app.request("/v1/market/submissions", {
      method: "POST",
      body: JSON.stringify({ repoUrl: submitted.repoUrl }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(201);

    const row = await versionRow(submitted.identifier, "0.3.0");
    expect(row.readmeStatus).toBe("ok");
    expect(row.readmeMd).toBe(bytes.toString("utf8"));
    expect(row.readmePath).toBe("README.md");
    expect(row.readmeRef).toBe(COMMIT);
    expect(row.readmeSha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(row.readmeNextFetchAt!.getTime() - before).toBeGreaterThanOrEqual(
      7 * DAY - 5_000,
    );
    expect(row.readmeNextFetchAt!.getTime() - Date.now()).toBeLessThanOrEqual(
      7 * DAY,
    );
    expect(row.provenanceJson.repository).toEqual({
      url: `https://github.com/${tag}/submitted`,
    });

    // The detail API shows it, with the file's own addresses.
    const detail = await app.request(
      `/v1/mcp/${encodeURIComponent(submitted.identifier)}`,
    );
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { readme: unknown }).readme).toEqual({
      status: "ok",
      markdown: bytes.toString("utf8"),
      source: {
        repoUrl: `https://github.com/${tag}/submitted`,
        ref: COMMIT,
        path: "README.md",
        blobUrl: `https://github.com/${tag}/submitted/blob/${COMMIT}/README.md`,
        rawUrl: `https://raw.githubusercontent.com/${tag}/submitted/${COMMIT}/README.md`,
      },
    });
    // Lists never carry README text.
    const list = await app.request(`/v1/mcp?query=${tag}&limit=100`);
    const listed = (await list.json()) as { items: Record<string, unknown>[] };
    expect(listed.items.length).toBeGreaterThan(0);
    for (const item of listed.items) {
      expect(item).not.toHaveProperty("readme");
      expect(JSON.stringify(item)).not.toContain("See [docs]");
    }
  });

  test("due versions: the latest published public one per server, installed > web > rest, newest first", async () => {
    // A clean catalog: the due scan is catalog-wide.
    await data.db.delete(data.mcpServers);
    const stdio = { transport: "stdio" as const, endpointUrl: undefined };
    const seed = async (
      name: string,
      overrides: Partial<MarketMcpManifest>,
      options: Partial<typeof federated> = {},
    ) => {
      const entry = manifest(name, overrides);
      await ingest.upsertMarketMcp({
        ...federated,
        ...options,
        manifest: entry,
      });
      return entry;
    };
    // Oldest first, so each later server is newer in the catalog.
    const installedStdio = await seed("installed-stdio", stdio);
    const webOld = await seed("web-old", {});
    const plainStdio = await seed("plain-stdio", stdio);
    const webNew = await seed("web-new", {});
    const reviewing = await seed("reviewing", {}, { status: "reviewing" });
    const privateServer = await seed("private", {}, { visibility: "private" });
    const versioned = await seed("versioned", {});
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: { ...versioned, version: "2.0.0" },
    });
    const notDue = await seed("not-due", {});
    await data.db
      .update(data.mcpServerVersions)
      .set({ readmeNextFetchAt: new Date(Date.now() + DAY) })
      .where(
        eq(
          data.mcpServerVersions.id,
          plan.mcpServerVersionId(notDue.identifier, "1.0.0"),
        ),
      );
    // Distinct publish times, in seeding order.
    const order = [
      installedStdio,
      webOld,
      plainStdio,
      webNew,
      reviewing,
      privateServer,
      versioned,
      notDue,
    ];
    for (const [index, entry] of order.entries()) {
      await data.db
        .update(data.mcpServers)
        .set({ publishedAt: new Date(Date.UTC(2026, 0, 1 + index)) })
        .where(eq(data.mcpServers.identifier, entry.identifier));
    }
    await data.db.execute(sql`
      update ${data.mcpServerVersions}
      set published_at = case version when '2.0.0' then now() else now() - interval '1 day' end
      where server_id = ${plan.mcpServerId(versioned.identifier)}
    `);
    const workspaceId = randomUUID();
    const teamId = randomUUID();
    await data.db.insert(data.workspaces).values({
      id: workspaceId,
      organizationId: teamId,
      name: "README priority",
      slug: `readme-priority-${workspaceId}`,
    });
    await data.db.insert(data.workspaceMcpInstalls).values({
      id: randomUUID(),
      teamId,
      workspaceId,
      marketIdentifier: installedStdio.identifier,
      name: "installed",
      transport: "stdio",
    });

    const due = await readmes.findDueMcpReadmes({ limit: 200 });
    expect(due.map((entry) => entry.identifier)).toEqual([
      installedStdio.identifier,
      versioned.identifier,
      webNew.identifier,
      webOld.identifier,
      plainStdio.identifier,
    ]);
    expect(due[0]).toMatchObject({ installed: true, webExecutable: false });
    expect(due[1]).toMatchObject({
      versionId: plan.mcpServerVersionId(versioned.identifier, "2.0.0"),
      installed: false,
      webExecutable: true,
    });
    expect((await readmes.findDueMcpReadmes({ limit: 2 })).length).toBe(2);

    // The scheduler queues exactly that batch.
    state.enqueue.mockClear();
    const scheduled = await fetching.scheduleDueMcpReadmes({
      jobExists: async () => false,
      findDue: readmes.findDueMcpReadmes,
      enqueue: state.enqueue,
    });
    expect(scheduled).toEqual({ queued: 5, inFlight: false });
    expect(state.enqueue.mock.calls[0]?.[0]).toEqual({
      versionIds: due.map((entry) => entry.versionId),
      reason: "scheduled",
    });
  });

  test("a batch stores every outcome, leases what it reads and defers the rest at a rate limit", async () => {
    await data.db.delete(data.mcpServers);
    const now = new Date();
    const names = [
      "ok",
      "sub",
      "unchanged",
      "missing",
      "big",
      "gitlab",
      "failing",
      "limited",
      "after",
    ];
    const entries: Record<string, MarketMcpManifest> = {};
    for (const name of names) {
      entries[name] = manifest(name, {
        repoUrl:
          name === "gitlab"
            ? `https://gitlab.com/${tag}/${name}`
            : `https://github.com/${tag}/${name}`,
      });
      await ingest.upsertMarketMcp({
        ...federated,
        manifest: entries[name]!,
        provenanceJson:
          name === "sub"
            ? { source: "registry.test", repository: { subfolder: "mcp" } }
            : { source: "registry.test" },
      });
    }
    const id = (name: string) =>
      plan.mcpServerVersionId(entries[name]!.identifier, "1.0.0");
    await readmes.writeMcpReadmeColumns(id("unchanged"), {
      readmeStatus: "ok",
      readmeMd: "# Unchanged",
      readmePath: "README.md",
      readmeRef: COMMIT,
      readmeSha256: "b".repeat(64),
      readmeEtag: '"unchanged"',
      readmeNextFetchAt: now,
    });
    await readmes.writeMcpReadmeColumns(id("missing"), {
      readmeStatus: "ok",
      readmeMd: "# Gone soon",
      readmePath: "README.md",
      readmeRef: COMMIT,
      readmeSha256: "c".repeat(64),
      readmeNextFetchAt: now,
    });
    await readmes.writeMcpReadmeColumns(id("failing"), { readmeAttempts: 4 });

    const resetAt = new Date(Date.now() + 30 * 60 * 1000);
    const results: Record<string, GitHubReadmeResult> = {
      ok: {
        status: "ok",
        markdown: "# OK",
        path: "README.md",
        ref: COMMIT,
        sha256: "d".repeat(64),
        etag: '"ok"',
        byteSize: 4,
        tokenPresent: true,
      },
      sub: {
        status: "ok",
        markdown: "# Sub",
        path: "mcp/README.md",
        ref: COMMIT,
        sha256: "e".repeat(64),
        etag: null,
        byteSize: 5,
        tokenPresent: true,
      },
      unchanged: { status: "not_modified", tokenPresent: true },
      missing: { status: "not_found", reason: "missing", tokenPresent: true },
      big: {
        status: "too_large",
        path: "README.md",
        byteSize: 600_000,
        etag: '"big"',
        tokenPresent: true,
      },
      failing: {
        status: "error",
        message: "GitHub README request failed 502",
        tokenPresent: true,
      },
      limited: { status: "rate_limited", resetAt, tokenPresent: true },
    };
    const fetchReadme = vi.fn(
      async (input: { repo: string }) => results[input.repo]!,
    );
    const summary = await fetching.fetchMcpReadmeBatch(
      { versionIds: names.map(id), reason: "scheduled" },
      {
        claim: readmes.claimMcpReadme,
        write: readmes.writeMcpReadmeColumns,
        defer: readmes.deferMcpReadmes,
        fetchReadme,
        record: async () => undefined,
        now: () => new Date(),
      },
    );

    expect(fetchReadme.mock.calls.map(([call]) => call)).toEqual([
      { owner: tag, repo: "ok", subfolder: "", etag: null },
      { owner: tag, repo: "sub", subfolder: "mcp", etag: null },
      { owner: tag, repo: "unchanged", subfolder: "", etag: '"unchanged"' },
      { owner: tag, repo: "missing", subfolder: "", etag: null },
      { owner: tag, repo: "big", subfolder: "", etag: null },
      { owner: tag, repo: "failing", subfolder: "", etag: null },
      { owner: tag, repo: "limited", subfolder: "", etag: null },
    ]);
    expect(summary).toMatchObject({
      processed: 8,
      skipped: 0,
      deferred: 1,
      rateLimitedUntil: resetAt.toISOString(),
    });

    const row = async (name: string) => {
      const [value] = await data.db
        .select()
        .from(data.mcpServerVersions)
        .where(eq(data.mcpServerVersions.id, id(name)));
      return value!;
    };
    const days = (value: Date | null) =>
      value ? Math.round((value.getTime() - Date.now()) / DAY) : null;

    expect(await row("ok")).toMatchObject({
      readmeStatus: "ok",
      readmeMd: "# OK",
      readmeEtag: '"ok"',
      readmeAttempts: 0,
    });
    expect(days((await row("ok")).readmeNextFetchAt)).toBe(7);
    expect(await row("sub")).toMatchObject({
      readmeStatus: "ok",
      readmePath: "mcp/README.md",
    });
    const unchanged = await row("unchanged");
    expect(unchanged).toMatchObject({
      readmeStatus: "ok",
      readmeMd: "# Unchanged",
      readmeEtag: '"unchanged"',
    });
    expect(unchanged.readmeFetchedAt).not.toBeNull();
    expect(days(unchanged.readmeNextFetchAt)).toBe(7);
    const missing = await row("missing");
    expect(missing).toMatchObject({
      readmeStatus: "not_found",
      readmeMd: null,
      readmePath: null,
      readmeSha256: null,
    });
    expect(days(missing.readmeNextFetchAt)).toBe(30);
    expect(await row("big")).toMatchObject({
      readmeStatus: "too_large",
      readmePath: "README.md",
      readmeEtag: '"big"',
    });
    const gitlab = await row("gitlab");
    expect(gitlab).toMatchObject({
      readmeStatus: "unsupported_host",
      readmeError: "The repository is not on github.com",
    });
    expect(days(gitlab.readmeNextFetchAt)).toBe(30);
    // The fifth failure in a row: stopped until an admin asks again.
    expect(await row("failing")).toMatchObject({
      readmeStatus: "error",
      readmeAttempts: 5,
      readmeNextFetchAt: null,
    });
    // The rate limit counts no attempt; it and the rest wait for the reset.
    expect(await row("limited")).toMatchObject({
      readmeStatus: "pending",
      readmeAttempts: 0,
    });
    expect((await row("limited")).readmeNextFetchAt!.getTime()).toBe(
      resetAt.getTime(),
    );
    expect((await row("after")).readmeNextFetchAt!.getTime()).toBe(
      resetAt.getTime(),
    );
    expect((await row("after")).readmeStatus).toBe("pending");

    // Nothing of the batch is due again before its time.
    expect(await readmes.findDueMcpReadmes({ limit: 200 })).toEqual([]);

    // A claim leases the version: a second claim, or one for a server that is
    // no longer public, gets nothing.
    await data.db
      .update(data.mcpServerVersions)
      .set({ readmeNextFetchAt: new Date(Date.now() - 1000) })
      .where(eq(data.mcpServerVersions.id, id("after")));
    const leaseUntil = new Date(Date.now() + 15 * 60 * 1000);
    expect(
      await readmes.claimMcpReadme({ versionId: id("after"), leaseUntil }),
    ).toMatchObject({
      versionId: id("after"),
      identifier: entries.after!.identifier,
      readmeStatus: "pending",
    });
    expect(
      await readmes.claimMcpReadme({ versionId: id("after"), leaseUntil }),
    ).toBeNull();
    await data.db
      .update(data.mcpServers)
      .set({ visibility: "private" })
      .where(eq(data.mcpServers.identifier, entries.ok!.identifier));
    await data.db
      .update(data.mcpServerVersions)
      .set({ readmeNextFetchAt: new Date(Date.now() - 1000) })
      .where(eq(data.mcpServerVersions.id, id("ok")));
    expect(
      await readmes.claimMcpReadme({ versionId: id("ok"), leaseUntil }),
    ).toBeNull();
  });

  test("an admin refetch resets the latest version and queues it; the status counts the catalog", async () => {
    await data.db.delete(data.mcpServers);
    const target = manifest("target");
    await ingest.upsertMarketMcp({ ...federated, manifest: target });
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: { ...target, version: "2.0.0" },
    });
    await data.db.execute(sql`
      update ${data.mcpServerVersions}
      set published_at = case version when '2.0.0' then now() else now() - interval '1 day' end
      where server_id = ${plan.mcpServerId(target.identifier)}
    `);
    const latest = plan.mcpServerVersionId(target.identifier, "2.0.0");
    await readmes.writeMcpReadmeColumns(latest, {
      readmeStatus: "error",
      readmeAttempts: 5,
      readmeError: "GitHub README request failed 502",
      readmeEtag: '"stale"',
      readmeNextFetchAt: null,
    });
    const other = manifest("other");
    await ingest.upsertMarketMcp({ ...federated, manifest: other });

    state.userId = "someone";
    const path = `/v1/market/admin/mcp/${encodeURIComponent(target.identifier)}/readme/refetch`;
    expect((await app.request(path, { method: "POST" })).status).toBe(403);

    state.userId = "market-admin";
    const status = await app.request("/v1/market/admin/mcp/readme/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      byStatus: {
        pending: 1,
        ok: 0,
        not_found: 0,
        too_large: 0,
        unsupported_host: 0,
        error: 1,
      },
      due: 1,
      stopped: 1,
      lastBatch: null,
    });

    state.enqueue.mockClear();
    const refetch = await app.request(path, { method: "POST" });
    expect(refetch.status).toBe(202);
    expect(await refetch.json()).toEqual({
      identifier: target.identifier,
      version: "2.0.0",
      status: "pending",
      queued: true,
    });
    expect(state.enqueue.mock.calls[0]).toEqual([
      { versionIds: [latest], reason: "admin" },
      `mcp-readme-fetch_admin_${latest}`,
    ]);
    const [reset] = await data.db
      .select()
      .from(data.mcpServerVersions)
      .where(eq(data.mcpServerVersions.id, latest));
    expect(reset).toMatchObject({
      readmeStatus: "pending",
      readmeAttempts: 0,
      readmeError: null,
      readmeEtag: null,
    });
    expect(reset!.readmeNextFetchAt!.getTime()).toBeLessThanOrEqual(Date.now());
    // The older version is left as it was.
    expect((await versionRow(target.identifier, "1.0.0")).readmeStatus).toBe(
      "pending",
    );

    const missing = await app.request(
      `/v1/market/admin/mcp/${encodeURIComponent(`io.github.${tag}/nothing`)}/readme/refetch`,
      { method: "POST" },
    );
    expect(missing.status).toBe(404);
  });
});
