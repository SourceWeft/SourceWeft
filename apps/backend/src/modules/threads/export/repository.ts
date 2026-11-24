import { database } from "@sourceweft/db";

/** Display names of the members who wrote an exported chat's messages. */
export async function findUserDisplayNames(
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) {
    return new Map();
  }
  const result = await database.query<{ id: string; name: string | null }>(
    `select id, name from "user" where id = any($1::text[])`,
    [ids],
  );
  return new Map(
    result.rows
      .filter((row) => row.name && row.name.trim().length > 0)
      .map((row) => [row.id, row.name!.trim()]),
  );
}
