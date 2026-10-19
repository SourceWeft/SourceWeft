import type { ShareLink } from "@sourceweft/contracts";
import { contentClient } from "../../../../../lib/sdk";

/**
 * Reads an artifact's share state for the preview header badge and shares the
 * lookup between every panel that asks for it around the same time. The
 * artifact preview is mounted more than once per open (the Hub's inline panel
 * and the expanded dialog, each doubled by React StrictMode in development),
 * which used to issue the same lookup four times.
 *
 * Overlapping callers share one in-flight request, and a settled answer is
 * reused only for a short burst window after it lands: the dialog mounts a
 * few milliseconds after the inline panel, long after the first lookup has
 * completed on a local API. Share state is mutated by the share dialog and can
 * change from another session, so the window is short and the panel calls
 * `forgetArtifactShare` on every mutation. Rejections (for example a
 * non-creator who may not read share state) reach every waiting caller
 * unchanged and are never remembered.
 */

const REUSE_WINDOW_MS = 2000;

type Settled = { share: ShareLink | null; at: number };

const inflight = new Map<string, Promise<ShareLink | null>>();
const settled = new Map<string, Settled>();

function shareKey(workspaceId: string, artifactId: string) {
  return `${workspaceId}:${artifactId}`;
}

export function loadArtifactShare(
  workspaceId: string,
  artifactId: string,
): Promise<ShareLink | null> {
  const key = shareKey(workspaceId, artifactId);
  const recent = settled.get(key);
  if (recent && Date.now() - recent.at < REUSE_WINDOW_MS) {
    return Promise.resolve(recent.share);
  }
  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }
  const request = contentClient
    .getArtifactShare(workspaceId, artifactId)
    .then((result) => {
      settled.set(key, { share: result.share, at: Date.now() });
      return result.share;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

/** Drop the remembered answer after a share mutation so the next mount fetches fresh. */
export function forgetArtifactShare(workspaceId: string, artifactId: string) {
  settled.delete(shareKey(workspaceId, artifactId));
}

/** Test hook: forget every outstanding and remembered share lookup. */
export function resetArtifactShareLookups() {
  inflight.clear();
  settled.clear();
}
