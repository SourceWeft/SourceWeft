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
import type { GitHubReadmeResult, GitHubReadmeTarget } from "./github-readme";

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
    readmeFetchedAt: row.readmeFetchedAt,
    readmeNextFetchAt: row.readmeNextFetchAt,
    readmeAttempts: row.readmeAttempts,
    readmeError: row.readmeError,
  });

  /** The README columns a read that found `markdown` at `at` stores. */
  const readColumns = (markdown: string, at: Date) => ({
    readmeStatus: "ok" as const,
    readmeMd: markdown,
    readmePath: "README.md",
    readmeRef: COMMIT,
    readmeSha256: createHash("sha256").update(markdown).digest("hex"),
    readmeFetchedAt: at,
    readmeNextFetchAt: new Date(at.getTime() + 7 * DAY),
    readmeAttempts: 0,
    readmeError: null,
  });

  /** Publish the versions of `identifier` in the order given, newest last. */
  async function publishInOrder(identifier: string, versions: string[]) {
    for (const [index, version] of versions.entries()) {
      await data.db
        .update(data.mcpServerVersions)
        .set({
          publishedAt: new Date(Date.now() - (versions.length - index) * DAY),
        })
        .where(
          eq(
            data.mcpServerVersions.id,
            plan.mcpServerVersionId(identifier, version),
          ),
        );
    }
  }

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

  test("a new version shows the previous version's README at once and is still due; a new server's first version stays pending", async () => {
    const carried = manifest("carried");
    await ingest.upsertMarketMcp({ ...federated, manifest: carried });
    const readAt = new Date(Date.now() - 2 * DAY);
    // Read two days ago, and failing to refresh since: the README is still
    // shown, the error says the refresh is failing.
    const previous = {
      ...readColumns("# Carried\n\nRead for 1.0.0.\n", readAt),
      readmeAttempts: 2,
      readmeError: "GitHub README request failed 502",
    };
    await readmes.writeMcpReadmeColumns(
      plan.mcpServerVersionId(carried.identifier, "1.0.0"),
      previous,
    );

    const before = Date.now();
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: { ...carried, version: "2.0.0" },
    });
    await publishInOrder(carried.identifier, ["1.0.0", "2.0.0"]);
    const fresh = await versionRow(carried.identifier, "2.0.0");
    expect(fresh).toMatchObject({
      readmeStatus: "ok",
      readmeMd: previous.readmeMd,
      readmePath: "README.md",
      readmeRef: COMMIT,
      readmeSha256: previous.readmeSha256,
      readmeFetchedAt: readAt,
      readmeError: previous.readmeError,
      // The version's own attempts, not the previous version's.
      readmeAttempts: 0,
    });
    // Still due at once, so the next batch reads it fresh.
    expect(fresh.readmeNextFetchAt!.getTime()).toBeGreaterThanOrEqual(
      before - 5_000,
    );
    expect(fresh.readmeNextFetchAt!.getTime()).toBeLessThanOrEqual(Date.now());
    const due = await readmes.findDueMcpReadmes({ limit: 1000 });
    expect(
      due.find((entry) => entry.identifier === carried.identifier),
    ).toEqual({
      versionId: fresh.id,
      identifier: carried.identifier,
      installed: false,
      neverRead: false,
    });
    // The previous version is left as it was.
    expect(
      readmeColumns(await versionRow(carried.identifier, "1.0.0")),
    ).toEqual(previous);

    // The detail API shows the carried README for the new latest version.
    const detail = await app.request(
      `/v1/mcp/${encodeURIComponent(carried.identifier)}`,
    );
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      item: { latestVersion: string | null };
      readme: unknown;
    };
    expect(body.item.latestVersion).toBe("2.0.0");
    expect(body.readme).toMatchObject({
      status: "ok",
      markdown: previous.readmeMd,
      source: { ref: COMMIT, path: "README.md" },
    });

    // The first version of a brand-new server has nothing to take over.
    const brandNew = manifest("brand-new");
    await ingest.upsertMarketMcp({ ...federated, manifest: brandNew });
    const first = await versionRow(brandNew.identifier);
    expect(first).toMatchObject({
      readmeStatus: "pending",
      readmeMd: null,
      readmePath: null,
      readmeRef: null,
      readmeSha256: null,
      readmeFetchedAt: null,
      readmeError: null,
      readmeAttempts: 0,
    });
    expect(
      await readmes.carryOverMcpReadme({
        serverId: plan.mcpServerId(brandNew.identifier),
        versionId: first.id,
      }),
    ).toBe(false);
  });

  test("a README a version has of its own is never replaced by the previous version's", async () => {
    const owned = manifest("owned");
    const serverId = plan.mcpServerId(owned.identifier);
    await ingest.upsertMarketMcp({ ...federated, manifest: owned });
    await readmes.writeMcpReadmeColumns(
      plan.mcpServerVersionId(owned.identifier, "1.0.0"),
      readColumns("# Owned 1.0.0\n", new Date(Date.now() - 3 * DAY)),
    );
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: { ...owned, version: "2.0.0" },
    });
    await publishInOrder(owned.identifier, ["1.0.0", "2.0.0"]);
    const latest = plan.mcpServerVersionId(owned.identifier, "2.0.0");
    expect((await versionRow(owned.identifier, "2.0.0")).readmeMd).toBe(
      "# Owned 1.0.0\n",
    );

    // The fetch job reads 2.0.0's own README; 1.0.0 is read again later.
    await readmes.writeMcpReadmeColumns(
      latest,
      readColumns("# Owned 2.0.0\n", new Date(Date.now() - DAY)),
    );
    await readmes.writeMcpReadmeColumns(
      plan.mcpServerVersionId(owned.identifier, "1.0.0"),
      readColumns("# Owned 1.0.0, again\n", new Date()),
    );
    const own = readmeColumns(await versionRow(owned.identifier, "2.0.0"));

    // A re-sync of 2.0.0 keeps its own README.
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: { ...owned, version: "2.0.0", summary: "Changed upstream" },
    });
    expect(readmeColumns(await versionRow(owned.identifier, "2.0.0"))).toEqual(
      own,
    );
    expect(
      await readmes.carryOverMcpReadme({ serverId, versionId: latest }),
    ).toBe(false);

    // So does one an admin sent back to `pending`: it was read before.
    expect(
      await readmes.resetMcpReadme({ identifier: owned.identifier }),
    ).toEqual({ versionId: latest, version: "2.0.0" });
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: { ...owned, version: "2.0.0" },
    });
    expect(await versionRow(owned.identifier, "2.0.0")).toMatchObject({
      readmeStatus: "pending",
      readmeMd: "# Owned 2.0.0\n",
    });

    // A submission of a new version stores the README its parse read over
    // the one carried over from the previous version.
    const submittedOwner = manifest("owned-submitted");
    await ingest.upsertMarketMcp({
      ...federated,
      origin: "submitted",
      manifest: submittedOwner,
      provenanceJson: { source: "submission", submittedBy: "submitter" },
    });
    await readmes.writeMcpReadmeColumns(
      plan.mcpServerVersionId(submittedOwner.identifier, "1.0.0"),
      readColumns("# Submitted 1.0.0\n", new Date(Date.now() - DAY)),
    );
    const bytes = Buffer.from("# Submitted 1.1.0\n");
    state.parse.mockResolvedValue({
      manifest: { ...submittedOwner, version: "1.1.0" },
      report: {
        installCommands: [],
        connections: [],
        github: {
          owner: tag,
          repo: "owned-submitted",
          ref: COMMIT,
          commitSha: COMMIT,
          repoUrl: submittedOwner.repoUrl,
          sourceUrl: submittedOwner.sourceUrl,
          subpath: "",
        },
      },
      readme: { path: "README.md", bytes },
    });
    state.userId = "submitter";
    const response = await app.request("/v1/market/submissions", {
      method: "POST",
      body: JSON.stringify({ repoUrl: submittedOwner.repoUrl }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(201);
    expect(await versionRow(submittedOwner.identifier, "1.1.0")).toMatchObject({
      readmeStatus: "ok",
      readmeMd: "# Submitted 1.1.0\n",
      readmeSha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  test("only a README that was read is carried over, the most recently read one", async () => {
    // 1.0.0 read three days ago, 2.0.0 found no README a day ago, 3.0.0 has
    // failed every read so far and 4.0.0 was never read: 5.0.0 takes 2.0.0's.
    const history = manifest("history");
    const id = (version: string) =>
      plan.mcpServerVersionId(history.identifier, version);
    for (const version of ["1.0.0", "2.0.0", "3.0.0", "4.0.0"]) {
      await ingest.upsertMarketMcp({
        ...federated,
        manifest: { ...history, version },
      });
    }
    await readmes.writeMcpReadmeColumns(
      id("1.0.0"),
      readColumns("# History\n", new Date(Date.now() - 3 * DAY)),
    );
    const notFoundAt = new Date(Date.now() - DAY);
    await readmes.writeMcpReadmeColumns(id("2.0.0"), {
      readmeStatus: "not_found",
      readmeMd: null,
      readmePath: null,
      readmeRef: null,
      readmeSha256: null,
      readmeFetchedAt: notFoundAt,
      readmeNextFetchAt: new Date(Date.now() + 29 * DAY),
      readmeAttempts: 0,
      readmeError: null,
    });
    await readmes.writeMcpReadmeColumns(id("3.0.0"), {
      readmeStatus: "error",
      readmeFetchedAt: new Date(),
      readmeAttempts: 5,
      readmeError: "GitHub README request failed 502",
      readmeNextFetchAt: null,
    });
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: { ...history, version: "5.0.0" },
    });
    expect(await versionRow(history.identifier, "5.0.0")).toMatchObject({
      readmeStatus: "not_found",
      readmeMd: null,
      readmeFetchedAt: notFoundAt,
      readmeError: null,
    });

    // A server whose only other version is pending, or failed, has nothing
    // to carry over.
    for (const [name, columns] of [
      ["unread", {}],
      [
        "failed",
        {
          readmeStatus: "error",
          readmeFetchedAt: new Date(),
          readmeAttempts: 5,
          readmeError: "GitHub README request failed 502",
          readmeNextFetchAt: null,
        },
      ],
    ] as const) {
      const entry = manifest(name);
      await ingest.upsertMarketMcp({ ...federated, manifest: entry });
      if (Object.keys(columns).length > 0) {
        await readmes.writeMcpReadmeColumns(
          plan.mcpServerVersionId(entry.identifier, "1.0.0"),
          columns,
        );
      }
      await ingest.upsertMarketMcp({
        ...federated,
        manifest: { ...entry, version: "2.0.0" },
      });
      expect(await versionRow(entry.identifier, "2.0.0")).toMatchObject({
        readmeStatus: "pending",
        readmeMd: null,
        readmeFetchedAt: null,
        readmeError: null,
        readmeAttempts: 0,
      });
    }
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

  test("due versions: the latest published public one per server, installed first, then never read, then the newest version", async () => {
    // A clean catalog: the due scan is catalog-wide.
    await data.db.delete(data.mcpServers);
    const seed = async (
      name: string,
      options: Partial<typeof federated> = {},
    ) => {
      const entry = manifest(name);
      await ingest.upsertMarketMcp({
        ...federated,
        ...options,
        manifest: entry,
      });
      return entry;
    };
    const id = (entry: MarketMcpManifest, version = "1.0.0") =>
      plan.mcpServerVersionId(entry.identifier, version);
    const installedRead = await seed("installed-read");
    const neverOld = await seed("never-old");
    const readOld = await seed("read-old");
    const neverNew = await seed("never-new");
    const readNew = await seed("read-new");
    const reviewing = await seed("reviewing", { status: "reviewing" });
    const privateServer = await seed("private", { visibility: "private" });
    const versioned = await seed("versioned");
    await ingest.upsertMarketMcp({
      ...federated,
      manifest: { ...versioned, version: "2.0.0" },
    });
    await publishInOrder(versioned.identifier, ["1.0.0", "2.0.0"]);
    const notDue = await seed("not-due");
    await data.db
      .update(data.mcpServerVersions)
      .set({ readmeNextFetchAt: new Date(Date.now() + DAY) })
      .where(eq(data.mcpServerVersions.id, id(notDue)));
    // Read a week ago and due again now.
    for (const entry of [installedRead, readOld, readNew]) {
      await readmes.writeMcpReadmeColumns(id(entry), {
        ...readColumns(`# ${entry.name}`, new Date(Date.now() - 8 * DAY)),
        readmeNextFetchAt: new Date(Date.now() - 1000),
      });
    }
    // Versions created in seeding order, their servers published in the
    // opposite one: the version's age orders the scan, not the server's.
    const servers = [
      installedRead,
      neverOld,
      readOld,
      neverNew,
      readNew,
      reviewing,
      privateServer,
      versioned,
      notDue,
    ];
    for (const [index, entry] of servers.entries()) {
      await data.db
        .update(data.mcpServers)
        .set({ publishedAt: new Date(Date.UTC(2026, 0, 31 - index)) })
        .where(eq(data.mcpServers.identifier, entry.identifier));
    }
    const created = [
      ...servers.slice(0, 7).map((entry) => id(entry)),
      id(versioned),
      id(versioned, "2.0.0"),
      id(notDue),
    ];
    for (const [index, versionId] of created.entries()) {
      await data.db
        .update(data.mcpServerVersions)
        .set({ createdAt: new Date(Date.UTC(2026, 0, 1 + index)) })
        .where(eq(data.mcpServerVersions.id, versionId));
    }
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
      marketIdentifier: installedRead.identifier,
      name: "installed",
      transport: "stdio",
    });

    const due = await readmes.findDueMcpReadmes({ limit: 200 });
    expect(due.map((entry) => entry.versionId)).toEqual([
      id(installedRead),
      id(versioned, "2.0.0"),
      id(neverNew),
      id(neverOld),
      id(readNew),
      id(readOld),
    ]);
    expect(due[0]).toEqual({
      versionId: id(installedRead),
      identifier: installedRead.identifier,
      installed: true,
      neverRead: false,
    });
    expect(due[1]).toEqual({
      versionId: id(versioned, "2.0.0"),
      identifier: versioned.identifier,
      installed: false,
      neverRead: true,
    });
    expect(due[4]).toMatchObject({ installed: false, neverRead: false });
    expect(
      (await readmes.findDueMcpReadmes({ limit: 2 })).map(
        (entry) => entry.versionId,
      ),
    ).toEqual(due.slice(0, 2).map((entry) => entry.versionId));

    // The scheduler queues exactly that batch.
    state.enqueue.mockClear();
    const scheduled = await fetching.scheduleDueMcpReadmes({
      jobExists: async () => false,
      findDue: readmes.findDueMcpReadmes,
      enqueue: state.enqueue,
    });
    expect(scheduled).toEqual({ queued: 6, inFlight: false });
    expect(state.enqueue.mock.calls[0]?.[0]).toEqual({
      versionIds: due.map((entry) => entry.versionId),
      reason: "scheduled",
    });
  });

  test("a claim leases the due versions of published public servers in one go", async () => {
    await data.db.delete(data.mcpServers);
    const seed = async (
      name: string,
      options: Partial<typeof federated> = {},
    ) => {
      const entry = manifest(name);
      await ingest.upsertMarketMcp({
        ...federated,
        ...options,
        manifest: entry,
        provenanceJson: {
          source: "registry.test",
          repository: { subfolder: name },
        },
      });
      return plan.mcpServerVersionId(entry.identifier, "1.0.0");
    };
    const read = await seed("claim-read");
    const unread = await seed("claim-unread");
    const notDue = await seed("claim-not-due");
    const privateServer = await seed("claim-private", {
      visibility: "private",
    });
    const reviewing = await seed("claim-reviewing", { status: "reviewing" });
    const readAt = new Date(Date.now() - 8 * DAY);
    const stored = readColumns("# Claim read\n", readAt);
    await readmes.writeMcpReadmeColumns(read, {
      ...stored,
      readmePath: "claim-read/README.md",
      readmeAttempts: 1,
      readmeNextFetchAt: new Date(Date.now() - 1000),
    });
    const notDueAt = new Date(Date.now() + DAY);
    await readmes.writeMcpReadmeColumns(notDue, {
      readmeNextFetchAt: notDueAt,
    });

    expect(
      await readmes.claimMcpReadmes({
        versionIds: [],
        leaseUntil: new Date(Date.now() + 15 * 60 * 1000),
      }),
    ).toEqual([]);

    const ids = [read, unread, notDue, privateServer, reviewing, "missing"];
    const leaseUntil = new Date(Date.now() + 15 * 60 * 1000);
    const claimed = await readmes.claimMcpReadmes({
      versionIds: ids,
      leaseUntil,
    });
    const byId = new Map(claimed.map((entry) => [entry.versionId, entry]));
    expect([...byId.keys()].sort()).toEqual([read, unread].sort());
    expect(byId.get(read)).toEqual({
      versionId: read,
      identifier: `io.github.${tag}/claim-read`,
      repoUrl: `https://github.com/${tag}/claim-read`,
      provenanceJson: {
        source: "registry.test",
        repository: { subfolder: "claim-read" },
      },
      readmeStatus: "ok",
      readmeAttempts: 1,
      readmePath: "claim-read/README.md",
      readmeSha256: stored.readmeSha256,
    });
    expect(byId.get(unread)).toMatchObject({
      readmeStatus: "pending",
      readmeAttempts: 0,
      readmePath: null,
      readmeSha256: null,
    });

    const nextFetch = async (versionId: string) => {
      const [row] = await data.db
        .select({ at: data.mcpServerVersions.readmeNextFetchAt })
        .from(data.mcpServerVersions)
        .where(eq(data.mcpServerVersions.id, versionId));
      return row!.at?.getTime() ?? null;
    };
    // Leased until `leaseUntil`; what was not claimed is left as it was.
    expect(await nextFetch(read)).toBe(leaseUntil.getTime());
    expect(await nextFetch(unread)).toBe(leaseUntil.getTime());
    expect(await nextFetch(notDue)).toBe(notDueAt.getTime());
    expect(await nextFetch(privateServer)).toBeLessThanOrEqual(Date.now());
    expect(await nextFetch(reviewing)).toBeLessThanOrEqual(Date.now());

    // While leased, a second claim (a redelivered batch) gets nothing.
    expect(
      await readmes.claimMcpReadmes({ versionIds: ids, leaseUntil }),
    ).toEqual([]);
    // Once the lease runs out, the version is claimed again.
    expect(
      (
        await readmes.claimMcpReadmes({
          versionIds: [read],
          leaseUntil: new Date(leaseUntil.getTime() + 15 * 60 * 1000),
          now: new Date(leaseUntil.getTime() + 1000),
        })
      ).map((entry) => entry.versionId),
    ).toEqual([read]);
  });

  test("a batch stores every outcome, and a rate limit makes what it reached wait for the reset", async () => {
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
    const unchangedFetchedAt = new Date(now.getTime() - 8 * DAY);
    await readmes.writeMcpReadmeColumns(id("unchanged"), {
      readmeStatus: "ok",
      readmeMd: "# Unchanged",
      readmePath: "README.md",
      readmeRef: COMMIT,
      readmeSha256: "b".repeat(64),
      readmeFetchedAt: unchangedFetchedAt,
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
    const newer = "f".repeat(40);
    const results: Record<string, GitHubReadmeResult> = {
      ok: {
        status: "ok",
        markdown: "# OK",
        path: "README.md",
        ref: COMMIT,
        sha256: "d".repeat(64),
        byteSize: 4,
      },
      sub: {
        status: "ok",
        markdown: "# Sub",
        path: "mcp/README.md",
        ref: COMMIT,
        sha256: "e".repeat(64),
        byteSize: 5,
      },
      // The same bytes, read at a newer commit.
      unchanged: {
        status: "ok",
        markdown: "# Unchanged",
        path: "README.md",
        ref: newer,
        sha256: "b".repeat(64),
        byteSize: 11,
      },
      missing: { status: "not_found", reason: "missing" },
      big: { status: "too_large", path: "README.md", byteSize: 600_000 },
      failing: {
        status: "error",
        message: "GitHub GraphQL request failed 502",
      },
      // GitHub's limit met mid-read leaves the rest of the read unanswered.
      limited: { status: "rate_limited", resetAt },
      after: { status: "rate_limited", resetAt },
    };
    const fetchReadmes = vi.fn(async (targets: GitHubReadmeTarget[]) => ({
      results: targets.map(({ repo }) => results[repo]!),
      cost: 1,
      remaining: 4000,
      resetAt,
    }));
    const summary = await fetching.fetchMcpReadmeBatch(
      { versionIds: names.map(id), reason: "scheduled" },
      {
        claim: readmes.claimMcpReadmes,
        write: readmes.writeMcpReadmeColumns,
        defer: readmes.deferMcpReadmes,
        fetchReadmes,
        hasToken: () => true,
        record: async () => undefined,
        now: () => new Date(),
      },
    );

    // One read for the group; the GitLab repository is not asked about.
    expect(fetchReadmes.mock.calls.map(([targets]) => targets)).toEqual([
      [
        { owner: tag, repo: "ok", subfolder: "" },
        { owner: tag, repo: "sub", subfolder: "mcp" },
        { owner: tag, repo: "unchanged", subfolder: "" },
        { owner: tag, repo: "missing", subfolder: "" },
        { owner: tag, repo: "big", subfolder: "" },
        { owner: tag, repo: "failing", subfolder: "" },
        { owner: tag, repo: "limited", subfolder: "" },
        { owner: tag, repo: "after", subfolder: "" },
      ],
    ]);
    expect(summary).toMatchObject({
      processed: 9,
      skipped: 0,
      deferred: 0,
      stoppedBy: "rate_limited",
      rateLimitedUntil: resetAt.toISOString(),
      points: 1,
      pointsRemaining: 4000,
      outcomes: {
        ok: 2,
        not_modified: 1,
        not_found: 1,
        too_large: 1,
        unsupported_host: 1,
        error: 1,
        rate_limited: 2,
      },
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
      readmeRef: COMMIT,
      readmeAttempts: 0,
    });
    expect(days((await row("ok")).readmeNextFetchAt)).toBe(7);
    expect(await row("sub")).toMatchObject({
      readmeStatus: "ok",
      readmePath: "mcp/README.md",
    });
    // Unchanged bytes keep the text and the commit they were pinned to.
    const unchanged = await row("unchanged");
    expect(unchanged).toMatchObject({
      readmeStatus: "ok",
      readmeMd: "# Unchanged",
      readmeRef: COMMIT,
    });
    expect(unchanged.readmeFetchedAt!.getTime()).toBeGreaterThan(
      unchangedFetchedAt.getTime(),
    );
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
    // The rate limit counts no attempt; what met it waits for the reset.
    for (const name of ["limited", "after"]) {
      const limited = await row(name);
      expect(limited).toMatchObject({
        readmeStatus: "pending",
        readmeAttempts: 0,
      });
      expect(limited.readmeNextFetchAt!.getTime()).toBe(resetAt.getTime());
    }

    // Nothing of the batch is due again before its time.
    expect(await readmes.findDueMcpReadmes({ limit: 200 })).toEqual([]);

    // What a stopped batch did not reach is pushed back to the reset, unless
    // it is no longer due.
    await data.db
      .update(data.mcpServerVersions)
      .set({ readmeNextFetchAt: new Date(Date.now() - 1000) })
      .where(eq(data.mcpServerVersions.id, id("after")));
    expect(
      await readmes.deferMcpReadmes({
        versionIds: [id("after"), id("ok")],
        until: resetAt,
      }),
    ).toBe(1);
    expect((await row("after")).readmeNextFetchAt!.getTime()).toBe(
      resetAt.getTime(),
    );
    expect(days((await row("ok")).readmeNextFetchAt)).toBe(7);
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
