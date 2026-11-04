import type { LocalNetworkRequest } from "@sourceweft/sdk";

/**
 * Pure helpers for the network-access approval card.
 *
 * A network approval is not a tool confirmation: the command is already
 * running and the device is waiting for the answer, so nothing here resumes,
 * stops or re-attaches a chat run.
 */

export const NETWORK_REQUEST_POLL_INTERVAL_MS = 1500;

function errorField(error: unknown, field: "code" | "status") {
  if (!error || typeof error !== "object") return undefined;
  return (error as Record<string, unknown>)[field];
}

export type NetworkResponseFailure =
  /** Answered elsewhere, timed out or gone: the card just disappears. */
  | "gone"
  /** The user lacks permission for a workspace-wide grant; `once` still works. */
  | "forbidden"
  | "failed";

export function classifyNetworkResponseError(
  error: unknown,
): NetworkResponseFailure {
  const code = errorField(error, "code");
  if (
    code === "NETWORK_REQUEST_RESOLVED" ||
    code === "NETWORK_REQUEST_EXPIRED" ||
    code === "NETWORK_REQUEST_NOT_FOUND"
  ) {
    return "gone";
  }
  if (code === "CONNECTOR_FORBIDDEN" || errorField(error, "status") === 403) {
    return "forbidden";
  }
  return "failed";
}

export function networkRequestRemainingMs(
  request: Pick<LocalNetworkRequest, "expiresAt">,
  now: number,
) {
  const expiresAt = Date.parse(request.expiresAt);
  // An unparseable deadline fails closed: the card is not offered.
  return Number.isFinite(expiresAt) ? expiresAt - now : 0;
}

export function formatNetworkRemaining(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/** Cards that are still answerable, oldest first (the server's order). */
export function visibleNetworkRequests(
  requests: LocalNetworkRequest[],
  now: number,
) {
  return requests.filter((request) => networkRequestRemainingMs(request, now) > 0);
}
