/**
 * Approving or revoking shared-data access happens inside the artifact
 * preview, while the "waiting for approval" marker lives in the hub list. The
 * two are mounted by different surfaces with no shared owner of artifact
 * state, so the preview announces the change on a window event (the same
 * bridge `artifact-delete-events` uses) and `useArtifacts` re-reads the marker.
 */

const ARTIFACT_APPROVAL_CHANGED_EVENT = "sourceweft:artifact-approval-changed";

export type ArtifactApprovalChangedDetail = {
  workspaceId: string;
  artifactId: string;
};

export function emitArtifactApprovalChanged(
  detail: ArtifactApprovalChangedDetail,
) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ArtifactApprovalChangedDetail>(
      ARTIFACT_APPROVAL_CHANGED_EVENT,
      { detail },
    ),
  );
}

export function subscribeArtifactApprovalChanged(
  listener: (detail: ArtifactApprovalChangedDetail) => void,
) {
  if (typeof window === "undefined") {
    return () => {};
  }
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ArtifactApprovalChangedDetail>).detail;
    if (detail?.workspaceId && detail.artifactId) {
      listener(detail);
    }
  };
  window.addEventListener(ARTIFACT_APPROVAL_CHANGED_EVENT, handler);
  return () => {
    window.removeEventListener(ARTIFACT_APPROVAL_CHANGED_EVENT, handler);
  };
}
