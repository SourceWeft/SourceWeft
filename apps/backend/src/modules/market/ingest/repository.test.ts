import { expect, test, vi } from "vitest";

// Only the statement upsertMcpCategories builds matters here, not a database.
vi.mock("@sourceweft/db", () => ({
  db: {},
  mcpCategories: { slug: "slug" },
  mcpServerCategories: {},
  mcpServers: {},
  mcpServerVersions: {},
}));
vi.mock("../readme/readme-repository", () => ({ carryOverMcpReadme: vi.fn() }));

import { mcpCategoryId, upsertMcpCategories } from "./repository";

test("category rows are written in one slug order, whatever order a caller lists them in", async () => {
  // Federation and the AI overview both upsert a server's categories; writing
  // them in a shared order keeps two concurrent upserts from deadlocking.
  const written: string[][] = [];
  const executor = {
    insert: () => ({
      values: (rows: { slug: string }[]) => {
        written.push(rows.map((row) => row.slug));
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  };

  const ids = await upsertMcpCategories(executor as never, [
    "developer-tools",
    "databases",
    "developer-tools",
  ]);

  expect(written).toEqual([["databases", "developer-tools"]]);
  expect(ids).toEqual([
    mcpCategoryId("databases"),
    mcpCategoryId("developer-tools"),
  ]);
});
