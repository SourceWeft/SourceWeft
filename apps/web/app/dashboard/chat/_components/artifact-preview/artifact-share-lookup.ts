import type { ShareLink } from "@sourceweft/contracts";
import { contentClient } from "../../../../../lib/sdk";

/**
 * Reads an artifact's share state for the preview header badge and shares the
 * outstanding request between every panel that asks while it is in flight.
 * The artifact preview is mounted more than once at a time (the Hub's inline
 * panel and the expanded dialog, each doubled by React StrictMode in
 * development), which used to issue the same lookup four times per open.
 *
 * Nothing is remembered after the request settles: share state is mutated by
 * the share dialog and may change from another session, so a later mount
 * always fetches fresh. Rejections (for example a non-creator who may not read
 * share state) reach every waiting caller unchanged.
 */

const inflight = new Map<string, Promise<ShareLink | null>>();

export function loadArtifactShare(
  workspaceId: string,
  artifactId: string,
): Promise<ShareLink | null> {
  const key = `${workspaceId}:${artifactId}`;
  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }
  const request = contentClient
    .getArtifactShare(workspaceId, artifactId)
    .then((result) => result.share)
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

/** Test hook: forget every outstanding share lookup. */
export function resetArtifactShareLookups() {
  inflight.clear();
}
