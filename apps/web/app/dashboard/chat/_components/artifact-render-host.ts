"use client";

/**
 * Installs the app-shell facilities capability-owned artifact UI is allowed to
 * reach: tool-output decoding, artifact URL construction, and artifact status
 * reconciliation. Importing this module registers the host as a side effect —
 * both artifact registries import it, so any render path that can reach a
 * capability component has already configured it.
 */
import { configureArtifactRenderHost } from "@sourceweft/agent-tool-registry/ui";
import { createAppArtifactRecordsTransport } from "../../../../lib/artifact-records-transport";
import { apiBaseUrl, contentClient } from "../../../../lib/sdk";
import { useArtifactStorageText } from "../../../../lib/use-artifact-storage-text";
import {
  resolveArtifactPageUrlFromArtifact,
  resolveArtifactPreviewImageUrlFromArtifact,
  resolveArtifactProxyFileUrlFromArtifact,
} from "./artifact-urls";
import {
  getToolOutputField,
  getToolOutputValue,
} from "./chat-canvas/message-assets";
import { useArtifactSnapshot } from "./chat-canvas/use-artifact-snapshot";
import { emitArtifactApprovalChanged } from "./sources-hub/artifacts/artifact-approval-events";

/** Tell the hub list its "waiting for approval" marker may have changed. */
function announcingApprovalChanges(
  transport: ReturnType<typeof createAppArtifactRecordsTransport>,
  detail: { workspaceId: string; artifactId: string },
) {
  const announce = (action: (() => Promise<void>) | undefined) =>
    action &&
    (async () => {
      await action();
      emitArtifactApprovalChanged(detail);
    });
  return {
    ...transport,
    approveShared: announce(transport.approveShared),
    revokeShared: announce(transport.revokeShared),
  };
}

configureArtifactRenderHost({
  readToolOutputField: getToolOutputField,
  readToolOutputValue: getToolOutputValue,
  resolveApiAssetUrl: (value) =>
    value.startsWith("/v1/") ? `${apiBaseUrl}${value}` : value,
  resolveArtifactPageUrl: resolveArtifactPageUrlFromArtifact,
  resolveArtifactFileUrl: resolveArtifactProxyFileUrlFromArtifact,
  resolveArtifactPreviewImageUrl: resolveArtifactPreviewImageUrlFromArtifact,
  useArtifactSnapshot,
  useArtifactStorageText,
  createArtifactRecordsTransport: (input) =>
    announcingApprovalChanges(
      createAppArtifactRecordsTransport(contentClient, input),
      { workspaceId: input.workspaceId, artifactId: input.artifactId },
    ),
});
