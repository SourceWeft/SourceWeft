import type { ThreadOrigin } from "@sourceweft/contracts";
import { ContentError } from "../../content/errors";

/**
 * Conversations a host owns end to end: a workspace assistant's Router
 * conversation and its ticket conversations. Only the host starts turns in
 * them (`startHostTurn`); a member can read them but cannot send, edit,
 * regenerate or resume a turn there, because the turn would run with the
 * host's tools under the member's own identity and without the host's
 * context.
 */
const HOST_OWNED_THREAD_ORIGINS: ReadonlySet<ThreadOrigin> = new Set([
  "assistant_router",
  "assistant_ticket",
]);

export function isHostOwnedThreadOrigin(
  origin: ThreadOrigin | null | undefined,
): boolean {
  return origin ? HOST_OWNED_THREAD_ORIGINS.has(origin) : false;
}

/**
 * Refuses a turn in a host-owned conversation unless the host started it.
 * `unattended: true` is the mark: it is host-only (no HTTP request schema
 * has it) and `startHostTurn` sets it on every run it starts.
 */
export function assertTurnAllowedInThread(
  thread: { origin?: ThreadOrigin | null },
  request: object,
): void {
  if (!isHostOwnedThreadOrigin(thread.origin)) return;
  const hostStarted =
    "unattended" in request &&
    (request as { unattended?: unknown }).unattended === true;
  if (hostStarted) return;
  throw new ContentError(
    403,
    "THREAD_HOST_OWNED",
    "This conversation is run by the workspace assistant and does not take messages",
  );
}
