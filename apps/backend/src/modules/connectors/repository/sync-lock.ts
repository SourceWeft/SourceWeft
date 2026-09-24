import { createDedicatedClient } from "@sourceweft/db";

/** A session-level PostgreSQL lock fences all trigger types for one connector.
 * It is released by PostgreSQL if the worker process dies. */
export async function tryAcquireConnectorSyncLock(connectorId: string) {
  const client = createDedicatedClient();
  try {
    await client.connect();
    const result = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired",
      [connectorId],
    );
    if (!result.rows[0]?.acquired) {
      await client.end();
      return null;
    }
    return async () => {
      try {
        await client.query(
          "select pg_advisory_unlock(hashtextextended($1, 0))",
          [connectorId],
        );
      } finally {
        await client.end();
      }
    };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}
