import { useEffect, useMemo, useRef, useState } from "react";
import { getArtifactProgressProtocol } from "@sourceweft/agent-tool-registry";
import { contentClient } from "../../../../../lib/sdk";
import { preferArtifactSnapshot } from "./artifact-work-state";
import { mapArtifactStatusSnapshot } from "./map-artifact-status-snapshot";
import type { ArtifactStatusSnapshot, ToolCallRecord } from "./types";

interface ArtifactRef {
  id: string;
  toolName: string;
}

/**
 * Generic artifact status hook with self-polling fallback.
 * Replaces useMergedVideoPresentationArtifactStatuses.
 */
export function useArtifactStatuses(input: {
  artifactStatuses?: ReadonlyMap<string, ArtifactStatusSnapshot>;
  toolCalls?: ToolCallRecord[];
  workspaceId?: string | null;
}): ReadonlyMap<string, ArtifactStatusSnapshot> {
  const artifacts = useMemo(() => {
    const result: ArtifactRef[] = [];
    for (const call of input.toolCalls ?? []) {
      const protocol = getArtifactProgressProtocol(call.tool);
      if (!protocol) continue;
      const id = protocol.extractArtifactId(call.output);
      if (id) result.push({ id, toolName: call.tool });
    }
    return result;
  }, [input.toolCalls]);

  const artifactIdsKey = artifacts.map((a) => a.id).join("\0");

  const [localStatuses, setLocalStatuses] = useState<
    Map<string, ArtifactStatusSnapshot>
  >(() => new Map());

  const parentStatusesRef = useRef(input.artifactStatuses);
  parentStatusesRef.current = input.artifactStatuses;
  const localStatusesRef = useRef(localStatuses);
  localStatusesRef.current = localStatuses;

  useEffect(() => {
    if (!input.workspaceId || artifacts.length === 0) {
      return;
    }

    const workspaceId = input.workspaceId;
    let cancelled = false;
    let inFlight = false;

    const refresh = async () => {
      if (inFlight) {
        return;
      }

      const pendingIds = artifacts.filter((artifact) => {
        const protocol = getArtifactProgressProtocol(artifact.toolName);
        if (!protocol) return false;

        const snapshot =
          preferArtifactSnapshot(
            parentStatusesRef.current?.get(artifact.id),
            localStatusesRef.current.get(artifact.id),
          ) ??
          localStatusesRef.current.get(artifact.id) ??
          parentStatusesRef.current?.get(artifact.id);

        return !protocol.isTerminal(snapshot);
      });

      if (pendingIds.length === 0) {
        return;
      }

      inFlight = true;
      try {
        const results = await Promise.allSettled(
          pendingIds.map(async (artifact) => {
            const result = await contentClient.getArtifact(
              workspaceId,
              artifact.id,
            );
            return mapArtifactStatusSnapshot(result.artifact);
          }),
        );

        if (cancelled) {
          return;
        }

        setLocalStatuses((current) => {
          const next = new Map(current);
          let changed = false;
          for (const result of results) {
            if (result.status !== "fulfilled") {
              continue;
            }
            const preferred = preferArtifactSnapshot(
              next.get(result.value.id),
              result.value,
            );
            if (preferred && preferred !== next.get(result.value.id)) {
              next.set(result.value.id, preferred);
              changed = true;
            }
          }
          return changed ? next : current;
        });
      } finally {
        inFlight = false;
      }
    };

    // One-shot reconciliation per artifact set. Live progress arrives through
    // the chat SSE (tool-call-event payloads carry the pipeline generation
    // record); this fetch only covers reopening a thread whose persisted tool
    // output is stale.
    void refresh();

    return () => {
      cancelled = true;
    };
    // Keyed on the joined ids so a new artifact set triggers exactly one fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactIdsKey, input.workspaceId]);

  return useMemo(() => {
    if (
      artifacts.length === 0 &&
      (!input.artifactStatuses || input.artifactStatuses.size === 0) &&
      localStatuses.size === 0
    ) {
      return input.artifactStatuses ?? new Map();
    }

    const merged = new Map(input.artifactStatuses ?? []);

    for (const [artifactId, snapshot] of localStatuses) {
      const preferred = preferArtifactSnapshot(
        merged.get(artifactId),
        snapshot,
      );
      if (preferred) {
        merged.set(artifactId, preferred);
      }
    }

    for (const [artifactId, snapshot] of input.artifactStatuses ?? []) {
      const preferred = preferArtifactSnapshot(
        merged.get(artifactId),
        snapshot,
      );
      if (preferred) {
        merged.set(artifactId, preferred);
      }
    }

    return merged;
  }, [artifacts.length, input.artifactStatuses, localStatuses]);
}
