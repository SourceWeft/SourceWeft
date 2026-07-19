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
  const [snapshot, setSnapshot] = useState<ArtifactStatusSnapshot | undefined>(
    input.artifactSnapshot,
  );

  useEffect(() => {
    setSnapshot((current) =>
      preferArtifactSnapshot(current, input.artifactSnapshot),
    );
  }, [input.artifactSnapshot]);

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
    let cancelled = false;

    void contentClient
      .getArtifact(workspaceId, artifactId)
      .then((result) => {
        if (!cancelled) {
          const next = mapArtifactStatusSnapshot(result.artifact);
          setSnapshot((current) => preferArtifactSnapshot(current, next));
        }
      })
      .catch(() => {
        // Keep tool-output fallback when REST is unavailable.
      });

    return () => {
      cancelled = true;
    };
    // Fetch once per artifact id; snapshot updates must not re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactId, input.enabled, input.workspaceId]);

  return {
    artifactId,
    snapshot,
  };
}
