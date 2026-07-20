"use client";

/**
 * Installs the app-shell facilities capability-owned artifact UI is allowed to
 * reach: tool-output decoding, artifact URL construction, and artifact status
 * reconciliation. Importing this module registers the host as a side effect —
 * both artifact registries import it, so any render path that can reach a
 * capability component has already configured it.
 */
import { configureArtifactRenderHost } from "@sourceweft/agent-tool-registry/ui";
import { apiBaseUrl } from "../../../../lib/sdk";
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

configureArtifactRenderHost({
  readToolOutputField: getToolOutputField,
  readToolOutputValue: getToolOutputValue,
  resolveApiAssetUrl: (value) =>
    value.startsWith("/v1/") ? `${apiBaseUrl}${value}` : value,
  resolveArtifactPageUrl: resolveArtifactPageUrlFromArtifact,
  resolveArtifactFileUrl: resolveArtifactProxyFileUrlFromArtifact,
  resolveArtifactPreviewImageUrl: resolveArtifactPreviewImageUrlFromArtifact,
  useArtifactSnapshot,
});
