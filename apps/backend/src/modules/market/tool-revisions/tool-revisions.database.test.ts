import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { marketMcpManifestSchema } from "@sourceweft/market-contracts";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

/**
 * Tool revisions (Issue #367): when a list becomes a revision, the diff, the
 * numbering under concurrency, retention, withdrawal and the read side.
 */

const tag = `trv${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const enc = encodeURIComponent;

const tool = (name: string, description = "") => ({
  name,
  description,
  inputSchema: { type: "object" },
  annotations: {},
});

function manifest(identifier: string) {
  return marketMcpManifestSchema.parse({
    schemaVersion: 1,
    identifier,
    version: "1.0.0",
    name: identifier,
    summary: "Summary",
    description: "Description",
    transport: "streamable_http",
    endpointUrl: `https://mcp.${tag}.com/mcp`,
    categories: ["developer-tools"],
    tools: [],
  });
}

describe("tool revisions", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let data: typeof import("@sourceweft/db");
  let revisions: typeof import("./index");
  let app: Hono;
  const originalUrl = process.env.DATABASE_URL;
  const ids = new Map<string, string>();

  async function item(name: string) {
    const identifier = `io.github.${tag}${name}/server`;
    await (await import("../ingest/repository")).upsertMarketMcp({
      status: "published",
      visibility: "public",
      origin: "upstream",
      source: "registry.test",
      manifest: manifest(identifier),
    });
    const [row] = await data.db
      .select({ id: data.mcpServers.id })
      .from(data.mcpServers)
      .where(eq(data.mcpServers.identifier, identifier));
    ids.set(name, row!.id);
    return { identifier, itemId: row!.id };
  }
  const rowsOf = (itemId: string, source = "owner") =>
    data.db
      .select()
      .from(data.marketMcpToolRevisions)
      .where(
        and(
          eq(data.marketMcpToolRevisions.itemId, itemId),
          eq(data.marketMcpToolRevisions.source, source as "owner"),
        ),
      )
      .orderBy(asc(data.marketMcpToolRevisions.revision));

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase("tool_revisions");
    process.env.DATABASE_URL = isolated.url;
    data = await import("@sourceweft/db");
    revisions = await import("./index");
    // Loaded only now: the harness reaches the DB singleton, which must see
    // the isolated database's URL.
    const { createRouteTestApp } = await import("../../../test/hono");
    const market = await import("../../../api/routes/market");
    app = createRouteTestApp((hono) => market.registerMarketRoutes(hono));
  }, 120_000);

  afterAll(async () => {
    if (data) await data.closeDatabase();
    if (isolated) await isolated.close();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  test("a list becomes revision 1; the same list again only confirms it", async () => {
    const { itemId } = await item("confirm");
    const first = await revisions.recordToolRevision({
      itemId,
      source: "owner",
      tools: [tool("a"), tool("b")],
      serverVersion: "2.0.0",
      observedAt: new Date("2026-10-24T10:00:00Z"),
    });
    expect(first).toMatchObject({ outcome: "created", revision: 1 });
    expect(first.diff).toEqual({ added: ["a", "b"], removed: [], changed: [] });

    const again = await revisions.recordToolRevision({
      itemId,
      source: "owner",
      // Reordered, with description whitespace noise.
      tools: [tool("b", "  "), tool("a")],
      serverVersion: "2.0.1",
      observedAt: new Date("2026-10-25T10:00:00Z"),
    });
    expect(again).toMatchObject({ outcome: "confirmed", revision: 1, diff: null });
    const rows = await rowsOf(itemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      serverVersion: "2.0.0",
      toolsHash: first.toolsHash,
      canonicalVersion: revisions.TOOL_CANONICAL_VERSION,
      observedAt: new Date("2026-10-24T10:00:00Z"),
      lastConfirmedAt: new Date("2026-10-25T10:00:00Z"),
    });
    // An older observation never moves the confirmation back.
    await revisions.recordToolRevision({
      itemId,
      source: "owner",
      tools: [tool("a"), tool("b")],
      observedAt: new Date("2026-10-20T10:00:00Z"),
    });
    expect((await rowsOf(itemId))[0]?.lastConfirmedAt).toEqual(new Date("2026-10-25T10:00:00Z"));
  });

  test("a difference is the next revision with a diff; the server's version is not the key", async () => {
    const { itemId } = await item("diff");
    await revisions.recordToolRevision({ itemId, source: "owner", tools: [tool("a"), tool("b"), tool("c")] });
    const second = await revisions.recordToolRevision({
      itemId,
      source: "owner",
      tools: [
        { ...tool("a"), inputSchema: { type: "object", properties: { q: { type: "string" } } } },
        tool("b", "Now documented"),
        tool("d"),
      ],
    });
    expect(second).toMatchObject({ outcome: "created", revision: 2 });
    expect(second.diff).toEqual({
      added: ["d"],
      removed: ["c"],
      changed: [
        { name: "a", fields: ["inputSchema"] },
        { name: "b", fields: ["description"] },
      ],
    });
    const rows = await rowsOf(itemId);
    expect(rows.map((row) => row.toolsCount)).toEqual([3, 3]);
    expect(rows[1]?.diffJson).toEqual(second.diff);
  });

  test("sources number independently", async () => {
    const { itemId } = await item("sources");
    for (const source of ["owner", "platform-indexed", "member-observed"] as const) {
      const result = await revisions.recordToolRevision({ itemId, source, tools: [tool("a")] });
      expect(result).toMatchObject({ outcome: "created", revision: 1 });
    }
    await revisions.recordToolRevision({ itemId, source: "platform-indexed", tools: [tool("a"), tool("b")] });
    expect((await rowsOf(itemId, "platform-indexed")).map((row) => row.revision)).toEqual([1, 2]);
    expect(await rowsOf(itemId, "owner")).toHaveLength(1);
  });

  test("an empty list is a valid revision, distinct from a withdrawal", async () => {
    const { itemId } = await item("empty");
    expect(await revisions.withdrawToolRevision({ itemId, source: "owner" })).toEqual({
      outcome: "none",
    });
    await revisions.recordToolRevision({ itemId, source: "owner", tools: [tool("a")] });
    const empty = await revisions.recordToolRevision({ itemId, source: "owner", tools: [] });
    expect(empty).toMatchObject({ outcome: "created", revision: 2 });
    expect(empty.diff).toEqual({ added: [], removed: ["a"], changed: [] });
    expect(
      await revisions.recordToolRevision({ itemId, source: "owner", tools: [] }),
    ).toMatchObject({ outcome: "confirmed", revision: 2 });

    const withdrawn = await revisions.withdrawToolRevision({ itemId, source: "owner" });
    expect(withdrawn).toMatchObject({ outcome: "withdrawn", revision: 3 });
    // Already withdrawn: nothing more to record.
    expect(await revisions.withdrawToolRevision({ itemId, source: "owner" })).toEqual({
      outcome: "none",
    });
    // The empty list differs from a withdrawal, and a list after one starts fresh.
    expect(
      await revisions.recordToolRevision({ itemId, source: "owner", tools: [] }),
    ).toMatchObject({ outcome: "created", revision: 4 });
    await revisions.withdrawToolRevision({ itemId, source: "owner" });
    const back = await revisions.recordToolRevision({ itemId, source: "owner", tools: [tool("a")] });
    expect(back).toMatchObject({ outcome: "created", revision: 6 });
    expect(back.diff).toEqual({ added: ["a"], removed: [], changed: [] });
    expect((await rowsOf(itemId)).map((row) => row.withdrawn)).toEqual([
      false, false, true, false, true, false,
    ]);
  });

  test("an invalid or oversize list throws and records nothing", async () => {
    const { itemId } = await item("bounds");
    const attempts = [
      Array.from({ length: 201 }, (_, i) => tool(`t${i}`)),
      [tool("a", "x".repeat(2001))],
      [{ name: "big", inputSchema: { blob: "x".repeat(33 * 1024) } }],
      [tool("dup"), tool("dup")],
    ];
    for (const tools of attempts) {
      await expect(
        revisions.recordToolRevision({ itemId, source: "owner", tools }),
      ).rejects.toBeInstanceOf(revisions.ToolRevisionInputError);
    }
    expect(await rowsOf(itemId)).toEqual([]);
    // The limits themselves are accepted.
    await revisions.recordToolRevision({
      itemId,
      source: "owner",
      tools: Array.from({ length: 200 }, (_, i) => tool(`t${i}`, "y".repeat(2000))),
    });
    expect(await rowsOf(itemId)).toHaveLength(1);
  });

  test("parallel callers never duplicate or skip a number", async () => {
    const { itemId } = await item("parallel");
    // Eight different lists at once: eight consecutive revisions.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        revisions.recordToolRevision({ itemId, source: "owner", tools: [tool(`t${i}`)] }),
      ),
    );
    expect(results.every((result) => result.outcome === "created")).toBe(true);
    expect((await rowsOf(itemId)).map((row) => row.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // Six callers with the same new list: one revision, five confirmations.
    const same = await Promise.all(
      Array.from({ length: 6 }, () =>
        revisions.recordToolRevision({ itemId, source: "owner", tools: [tool("same")] }),
      ),
    );
    expect(same.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(same.filter((result) => result.outcome === "confirmed")).toHaveLength(5);
    expect(new Set(same.map((result) => result.revision)).size).toBe(1);
    expect(await rowsOf(itemId)).toHaveLength(9);
  });

  test("the latest fifty keep their list; older ones keep only the diff", async () => {
    const { itemId } = await item("retention");
    for (let i = 1; i <= 55; i += 1) {
      await revisions.recordToolRevision({
        itemId,
        source: "owner",
        tools: [tool("a", `version ${i}`)],
      });
    }
    const rows = await rowsOf(itemId);
    expect(rows).toHaveLength(55);
    expect(rows.slice(0, 5).every((row) => row.toolsJson === null)).toBe(true);
    expect(rows.slice(5).every((row) => Array.isArray(row.toolsJson))).toBe(true);
    // The summary of an old revision survives.
    expect(rows[2]?.diffJson).toEqual({
      added: [],
      removed: [],
      changed: [{ name: "a", fields: ["description"] }],
    });
    expect(rows[2]?.toolsCount).toBe(1);
    // Comparing still works against the newest.
    expect(
      await revisions.recordToolRevision({ itemId, source: "owner", tools: [tool("a", "version 55")] }),
    ).toMatchObject({ outcome: "confirmed", revision: 55 });
  }, 120_000);

  test("inside the caller's transaction it commits or rolls back with it", async () => {
    const { itemId } = await item("tx");
    await expect(
      data.db.transaction(async (tx) => {
        await revisions.recordToolRevision({ itemId, source: "owner", tools: [tool("a")] }, { tx });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await rowsOf(itemId)).toEqual([]);
    await data.db.transaction(async (tx) => {
      await revisions.recordToolRevision({ itemId, source: "owner", tools: [tool("a")] }, { tx });
    });
    expect(await rowsOf(itemId)).toHaveLength(1);
  });

  test("a revision made under an older canonical form is re-derived, not duplicated", async () => {
    const { itemId } = await item("version");
    await revisions.recordToolRevision({ itemId, source: "owner", tools: [tool("a")] });
    await data.db
      .update(data.marketMcpToolRevisions)
      .set({ canonicalVersion: 0, toolsHash: "old-form-hash" })
      .where(eq(data.marketMcpToolRevisions.itemId, itemId));
    expect(
      await revisions.recordToolRevision({ itemId, source: "owner", tools: [tool("a")] }),
    ).toMatchObject({ outcome: "confirmed", revision: 1 });
  });

  test("revisions go with the item", async () => {
    const { itemId } = await item("cascade");
    await revisions.recordToolRevision({ itemId, source: "owner", tools: [tool("a")] });
    await data.db.delete(data.mcpServers).where(eq(data.mcpServers.id, itemId));
    expect(await rowsOf(itemId)).toEqual([]);
  });

  describe("read side", () => {
    test("the displayed source is owner, then platform, then member; withdrawn and hidden owner lists are skipped", async () => {
      const { itemId } = await item("display");
      expect(await revisions.readToolsRevision(itemId, true)).toBeNull();
      await revisions.recordToolRevision({ itemId, source: "member-observed", tools: [tool("m")] });
      expect(await revisions.readToolsRevision(itemId, true)).toMatchObject({
        source: "member-observed",
        revision: 1,
      });
      await revisions.recordToolRevision({ itemId, source: "platform-indexed", tools: [tool("p")] });
      await revisions.recordToolRevision({ itemId, source: "owner", tools: [tool("o")] });
      expect(await revisions.readToolsRevision(itemId, true)).toMatchObject({ source: "owner" });
      // The owner's list is not shown (author without a claim): the next source is.
      expect(await revisions.readToolsRevision(itemId, false)).toMatchObject({
        source: "platform-indexed",
      });
      await revisions.withdrawToolRevision({ itemId, source: "owner" });
      expect(await revisions.readToolsRevision(itemId, true)).toMatchObject({
        source: "platform-indexed",
      });
    });

    test("pages newest first with a cursor, and the endpoint's shape and bounds", async () => {
      const { identifier, itemId } = await item("page");
      for (let i = 1; i <= 5; i += 1) {
        await revisions.recordToolRevision({
          itemId,
          source: "owner",
          tools: [tool("a", `v${i}`)],
          serverVersion: i === 1 ? "9.9.9" : null,
        });
      }
      const url = (query = "") => `/v1/mcp/${enc(identifier)}/tools/revisions${query}`;
      // The owner layer shows no list in this test (no claim): nothing public.
      const hidden = await app.request(url());
      expect(hidden.status).toBe(200);
      expect(await hidden.json()).toEqual({ source: null, items: [], nextBefore: null });

      // Without the owner, the platform source's history is what the page shows.
      for (let i = 1; i <= 5; i += 1) {
        await revisions.recordToolRevision({
          itemId,
          source: "platform-indexed",
          tools: [tool("a", `v${i}`)],
          serverVersion: i === 1 ? "9.9.9" : null,
        });
      }
      const first = (await (await app.request(url("?limit=2"))).json()) as {
        source: string;
        items: Array<Record<string, unknown>>;
        nextBefore: number | null;
      };
      expect(first.source).toBe("platform-indexed");
      expect(first.items.map((entry) => [entry.revision, entry.current])).toEqual([
        [5, true],
        [4, false],
      ]);
      expect(first.items[0]).toEqual({
        source: "platform-indexed",
        revision: 5,
        current: true,
        withdrawn: false,
        toolsCount: 1,
        serverVersion: null,
        observedAt: expect.any(String),
        lastConfirmedAt: expect.any(String),
        added: [],
        removed: [],
        changed: [{ name: "a", fields: ["description"] }],
      });
      expect(first.nextBefore).toBe(4);
      const last = (await (await app.request(url("?limit=2&before=3"))).json()) as typeof first;
      expect(last.items.map((entry) => entry.revision)).toEqual([2, 1]);
      expect(last.items[1]).toMatchObject({ serverVersion: "9.9.9", added: ["a"] });
      expect(last.nextBefore).toBeNull();
      // Stored lists never leave the server.
      expect(JSON.stringify(first)).not.toContain("inputSchema");

      for (const bad of ["?limit=0", "?limit=51", "?before=0", "?source=nope", "?limit=abc"]) {
        expect((await app.request(url(bad))).status).toBe(400);
      }
      expect((await app.request(`/v1/mcp/${enc("io.github.nobody/none")}/tools/revisions`)).status).toBe(404);
      // The detail carries the current revision of the displayed source.
      const detail = (await (await app.request(`/v1/mcp/${enc(identifier)}`)).json()) as {
        toolsRevision: unknown;
      };
      expect(detail.toolsRevision).toMatchObject({ source: "platform-indexed", revision: 5 });
    });
  });
});
