"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import type { GroundedEvidence } from "@sourceweft/contracts/grounded-evidence";
import type { CitationRecord } from "../chat-canvas/types";

// The source preview pulls in the document viewer; load it on first open.
const SourcePreviewPanel = dynamic(
  () => import("../source-preview-panel").then((mod) => mod.SourcePreviewPanel),
  { ssr: false },
);

type OpenEvidence = { evidence: GroundedEvidence; workspaceId: string };

/**
 * Artifact viewers ask the app to open a source at a quote (a table cell's
 * evidence, a study card's) while the app owns the source preview. This is the
 * one place that request lands: viewers call `openGroundedEvidenceSource`,
 * and `GroundedEvidenceSourcePreview`, mounted next to every capability-owned
 * preview, shows it.
 */
let current: OpenEvidence | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openGroundedEvidenceSource(
  evidence: GroundedEvidence,
  context: { workspaceId: string; artifactId: string },
) {
  current = { evidence, workspaceId: context.workspaceId };
  emit();
}

/** The citation record the source preview expects for a stored evidence entry. */
export function evidenceCitationRecord(evidence: GroundedEvidence): CitationRecord {
  const anchored =
    evidence.startChar !== undefined && evidence.endChar !== undefined;
  return {
    citation: "",
    sourceId: evidence.sourceId,
    documentId: evidence.documentId,
    chunkId: evidence.chunkId,
    chunkNo: evidence.chunkNo,
    score: 0,
    excerpt: evidence.quote,
    ...(anchored
      ? {
          support: "strong" as const,
          startChar: evidence.startChar,
          endChar: evidence.endChar,
          spanText: evidence.quote,
        }
      : {}),
  };
}

export function GroundedEvidenceSourcePreview() {
  const active = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  if (!active) return null;
  return (
    <SourcePreviewPanel
      citation={evidenceCitationRecord(active.evidence)}
      onOpenChange={(open) => {
        if (!open) {
          current = null;
          emit();
        }
      }}
      open
      workspaceId={active.workspaceId}
    />
  );
}
