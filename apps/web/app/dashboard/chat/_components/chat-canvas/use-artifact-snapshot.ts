import { useEffect, useState } from "react";
import { contentClient } from "../../../../../lib/sdk";
import {
  isArtifactSnapshotTerminal,
  preferArtifactSnapshot,
  resolveToolCallArtifactId,
} from "./artifact-work-state";
import { mapArtifactStatusSnapshot } from "./map-artifact-status-snapshot";
import type { ArtifactStatusSnapshot } from "./types";

export function useArtifactSnapshot(input: {
  artifactSnapshot?: ArtifactStatusSnapshot;
  enabled?: boolean;
  toolCallOutput?: unknown;
  workspaceId?: string | null;
}) {
  const artifactId = resolveToolCallArtifactId(input.toolCallOutput);
  const identity =
    input.workspaceId && artifactId
      ? `${input.workspaceId}\u0000${artifactId}`
      : null;
  const parentSnapshotMatches =
    !input.artifactSnapshot ||
    (input.artifactSnapshot.id === artifactId &&
      (!input.workspaceId ||
        input.artifactSnapshot.workspaceId === input.workspaceId));
  const parentSnapshot = parentSnapshotMatches
    ? input.artifactSnapshot
    : undefined;
  const [state, setState] = useState<{
    error: string | null;
    identity: string | null;
    snapshot?: ArtifactStatusSnapshot;
  }>(() => ({ error: null, identity, snapshot: parentSnapshot }));
  // Effects run after render. Select by identity here as well so switching
  // thread/artifact can never paint the previous terminal snapshot for a frame.
  const stateForIdentity =
    state.identity === identity
      ? state
      : { error: null, identity, snapshot: parentSnapshot };
  const snapshot = preferArtifactSnapshot(
    stateForIdentity.snapshot,
    parentSnapshot,
  );
  const error = stateForIdentity.error;

  useEffect(() => {
    setState((current) => {
      if (current.identity !== identity) {
        return { error: null, identity, snapshot: parentSnapshot };
      }
      const nextSnapshot = preferArtifactSnapshot(
        current.snapshot,
        parentSnapshot,
      );
      if (nextSnapshot === current.snapshot && current.error === null) {
        return current;
      }
      return {
        error: parentSnapshot ? null : current.error,
        identity,
        snapshot: nextSnapshot,
      };
    });
  }, [identity, parentSnapshot]);

  // One-shot reconciliation only. Live progress arrives through the chat SSE
  // (tool-call-event payloads carry the pipeline generation record), so no
  // interval polling: this fetch covers reopening a thread whose persisted
  // tool output is stale (e.g. a degraded processing_result).
  useEffect(() => {
    if (
      input.enabled === false ||
      !input.workspaceId ||
      !artifactId ||
      isArtifactSnapshotTerminal(snapshot)
    ) {
      return;
    }

    const workspaceId = input.workspaceId;
    const expectedIdentity = identity;
    let cancelled = false;

    void contentClient
      .getArtifact(workspaceId, artifactId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        const next = mapArtifactStatusSnapshot(result.artifact);
        if (next.id !== artifactId || next.workspaceId !== workspaceId) {
          setState((current) =>
            current.identity === expectedIdentity
              ? {
                  error: "Artifact details did not match the request.",
                  identity: expectedIdentity,
                  snapshot: undefined,
                }
              : current,
          );
          return;
        }
        setState((current) =>
          current.identity === expectedIdentity
            ? {
                error: null,
                identity: expectedIdentity,
                snapshot: preferArtifactSnapshot(current.snapshot, next),
              }
            : current,
        );
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setState((current) =>
          current.identity === expectedIdentity
            ? {
                ...current,
                error: "Artifact details could not be loaded.",
              }
            : current,
        );
      });

    return () => {
      cancelled = true;
    };
    // Fetch once per artifact id; snapshot updates must not re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactId, identity, input.enabled, input.workspaceId]);

  return {
    artifactId,
    error,
    snapshot,
  };
}
