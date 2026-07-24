import { database } from "@sourceweft/db";
import { THREAD_EVENTS_CHANNEL, type ThreadEventPayload } from "./types";

// Postgres caps a NOTIFY payload at 8000 bytes. ID-only payloads are ~150-300
// bytes, so this only ever fires on a programming error (accidentally putting
// content in the payload) — which we want to catch loudly, not truncate.
const MAX_NOTIFY_BYTES = 8000;

export function serializeThreadEvent(payload: ThreadEventPayload): string {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") >= MAX_NOTIFY_BYTES) {
    throw new Error(
      `Thread event payload exceeds the NOTIFY limit (${MAX_NOTIFY_BYTES} bytes)`,
    );
  }
  return body;
}

/**
 * Broadcast a thread event to every listening process (including this one).
 * Uses the shared pool — a short `pg_notify` statement is exactly what pooling
 * is for. Callers publish fire-and-forget (`void publishThreadEvent(...).catch`)
 * so a NOTIFY failure never blocks or rolls back the surrounding write.
 */
export async function publishThreadEvent(
  payload: ThreadEventPayload,
): Promise<void> {
  const body = serializeThreadEvent(payload);
  await database.query("SELECT pg_notify($1, $2)", [
    THREAD_EVENTS_CHANNEL,
    body,
  ]);
}
