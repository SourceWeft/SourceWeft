import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let artifacts: typeof import("../artifacts/repository");
let sources: typeof import("../sources/repository");
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
const teamId = randomUUID();
const workspaceId = randomUUID();
const expected = ["07", "06", "05", "04", "03", "02", "01"];

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("content_pages");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  artifacts = await import("../artifacts/repository");
  sources = await import("../sources/repository");
  await schema.database.query(
    'insert into organization (id, name, slug, "createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Pagination",
    slug: workspaceId,
  });
  for (const [index, id] of expected.entries()) {
    const at = new Date(Date.UTC(2026, 0, 5 - Math.floor(index / 3)));
    await schema.db.insert(schema.artifacts).values({
      id,
      teamId,
      workspaceId,
      artifactType: "image",
      status: "ready",
      createdAt: at,
      updatedAt: at,
    });
    await schema.db.insert(schema.sources).values({
      id,
      teamId,
      workspaceId,
      title: id,
      createdAt: at,
      updatedAt: at,
    });
  }
}, 120_000);

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

for (const kind of [
  "artifacts",
  "artifact-summaries",
  "sources",
  "source-mentions",
] as const) {
  test.each([1, 2, 3, 7])(
    `${kind}: pages of %i cover all rows exactly once`,
    async (limit) => {
      let cursor: string | undefined;
      const ids: string[] = [];
      for (let pageNumber = 0; pageNumber <= expected.length; pageNumber++) {
        const decoded = cursor
          ? JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
          : null;
        const scope = { teamId, workspaceId, limit };
        const artifactCursor = decoded
          ? { id: decoded.id as string, createdAt: new Date(decoded.createdAt) }
          : null;
        const page =
          kind === "artifacts"
            ? await artifacts.listArtifactRecords({
                ...scope,
                cursor: artifactCursor,
              })
            : kind === "artifact-summaries"
              ? await artifacts.listArtifactSummaryRecords({
                  ...scope,
                  cursor: artifactCursor,
                })
              : kind === "sources"
                ? await sources.listSourceRecords({
                    ...scope,
                    view: "page",
                    includeContent: false,
                    cursor,
                  })
                : await sources.listSourceMentionRecords({ ...scope, cursor });
        ids.push(...page.items.map((item) => item.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      assert.deepEqual(ids, expected);
      assert.equal(new Set(ids).size, expected.length);
    },
  );
}
