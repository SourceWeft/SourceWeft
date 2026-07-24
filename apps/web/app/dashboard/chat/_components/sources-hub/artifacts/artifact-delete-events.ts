/**
 * A deleted artifact must vanish from every artifact list immediately, but the
 * preview panel that performs the delete and the hub list that shows the row
 * are mounted by different surfaces (side panel, sheet, standalone page) with
 * no shared ancestor that owns artifact state. A window event is the narrow
 * bridge: the panel announces the deletion, `useArtifacts` evicts the row from
 * its state and caches, and no surface needs a new prop threaded through it.
 */

const ARTIFACT_DELETED_EVENT = "sourceweft:artifact-deleted";

export type ArtifactDeletedDetail = {
  workspaceId: string;
  artifactId: string;
};

export function emitArtifactDeleted(detail: ArtifactDeletedDetail) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ArtifactDeletedDetail>(ARTIFACT_DELETED_EVENT, { detail }),
  );
}

export function subscribeArtifactDeleted(
  listener: (detail: ArtifactDeletedDetail) => void,
) {
  if (typeof window === "undefined") {
    return () => {};
  }
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ArtifactDeletedDetail>).detail;
    if (detail?.workspaceId && detail.artifactId) {
      listener(detail);
    }
  };
  window.addEventListener(ARTIFACT_DELETED_EVENT, handler);
  return () => {
    window.removeEventListener(ARTIFACT_DELETED_EVENT, handler);
  };
}
