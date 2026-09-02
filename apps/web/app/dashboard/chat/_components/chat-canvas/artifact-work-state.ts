import { getToolOutputField } from "./message-assets";
import type { ArtifactStatusSnapshot, ToolCallRecord } from "./types";

type ArtifactLifecycleStatus = ArtifactStatusSnapshot["status"];

function readGenerationStatus(
  snapshot?: ArtifactStatusSnapshot | null,
): ArtifactLifecycleStatus | null {
  const payload = snapshot?.payloadJson;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const generation = (payload as Record<string, unknown>).generation;
  if (
    !generation ||
    typeof generation !== "object" ||
    Array.isArray(generation)
  ) {
    return null;
  }
  const status = (generation as Record<string, unknown>).status;
  if (
    status === "pending" ||
    status === "running" ||
    status === "ready" ||
    status === "failed" ||
    status === "archived"
  ) {
    return status;
  }
  if (status === "processing") {
    return "running";
  }
  return null;
}

/** Prefer payloadJson.generation.status when present; else row status. */
export function resolveArtifactLifecycleStatus(
  snapshot?: ArtifactStatusSnapshot | null,
): ArtifactLifecycleStatus | null {
  if (!snapshot) {
    return null;
  }
  return readGenerationStatus(snapshot) ?? snapshot.status;
}

export function isArtifactStatusActive(
  status: ArtifactLifecycleStatus | null | undefined,
) {
  return status === "pending" || status === "running";
}

export function isArtifactSnapshotActive(
  snapshot?: ArtifactStatusSnapshot | null,
) {
  return isArtifactStatusActive(resolveArtifactLifecycleStatus(snapshot));
}

/** Missing snapshot is not terminal — keep polling until we learn otherwise. */
export function isArtifactSnapshotTerminal(
  snapshot?: ArtifactStatusSnapshot | null,
) {
  const status = resolveArtifactLifecycleStatus(snapshot);
  return status === "ready" || status === "failed" || status === "archived";
}

function readGenerationRecord(payloadJson: unknown) {
  if (
    !payloadJson ||
    typeof payloadJson !== "object" ||
    Array.isArray(payloadJson)
  ) {
    return null;
  }
  const generation = (payloadJson as Record<string, unknown>).generation;
  if (
    !generation ||
    typeof generation !== "object" ||
    Array.isArray(generation)
  ) {
    return null;
  }
  return generation as Record<string, unknown>;
}

function pickRicherText(primary?: unknown, fallback?: unknown) {
  const a = typeof primary === "string" ? primary : "";
  const b = typeof fallback === "string" ? fallback : "";
  if (!a) {
    return b || undefined;
  }
  if (!b) {
    return a;
  }
  return a.length >= b.length ? a : b;
}

function mergePipelineStepsPreferRicher(
  primarySteps: unknown,
  fallbackSteps: unknown,
) {
  if (!Array.isArray(primarySteps)) {
    return Array.isArray(fallbackSteps) ? fallbackSteps : primarySteps;
  }
  if (!Array.isArray(fallbackSteps)) {
    return primarySteps;
  }
  const fallbackById = new Map<string, Record<string, unknown>>();
  for (const step of fallbackSteps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      continue;
    }
    const id = (step as Record<string, unknown>).id;
    if (typeof id === "string") {
      fallbackById.set(id, step as Record<string, unknown>);
    }
  }
  return primarySteps.map((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      return step;
    }
    const record = step as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const fallback = id ? fallbackById.get(id) : undefined;
    if (!fallback) {
      return step;
    }
    const primaryLog = Array.isArray(record.logTail) ? record.logTail : [];
    const fallbackLog = Array.isArray(fallback.logTail) ? fallback.logTail : [];
    return {
      ...fallback,
      ...record,
      summary: pickRicherText(record.summary, fallback.summary),
      display: pickRicherText(record.display, fallback.display),
      logTail:
        primaryLog.length >= fallbackLog.length ? primaryLog : fallbackLog,
    };
  });
}

/**
 * Keep richer per-step display/summary when merging snapshots so a budgeted
 * SSE payload cannot wipe fuller REST step output at the same progress.
 */
export function mergeArtifactSnapshotStepDetail(
  primary: ArtifactStatusSnapshot,
  fallback?: ArtifactStatusSnapshot,
): ArtifactStatusSnapshot {
  if (!fallback) {
    return primary;
  }
  const primaryGeneration = readGenerationRecord(primary.payloadJson);
  const fallbackGeneration = readGenerationRecord(fallback.payloadJson);
  if (!primaryGeneration || !fallbackGeneration) {
    return primary;
  }
  const mergedSteps = mergePipelineStepsPreferRicher(
    primaryGeneration.pipelineSteps,
    fallbackGeneration.pipelineSteps,
  );
  if (!Array.isArray(mergedSteps)) {
    return primary;
  }
  const payloadJson =
    primary.payloadJson &&
    typeof primary.payloadJson === "object" &&
    !Array.isArray(primary.payloadJson)
      ? {
          ...(primary.payloadJson as Record<string, unknown>),
          generation: {
            ...fallbackGeneration,
            ...primaryGeneration,
            pipelineSteps: mergedSteps,
          },
        }
      : {
          generation: {
            ...fallbackGeneration,
            ...primaryGeneration,
            pipelineSteps: mergedSteps,
          },
        };
  return {
    ...primary,
    payloadJson,
  };
}

/**
 * Monotonic merge for artifact snapshots.
 * Never downgrade terminal → in-progress (fixes ready flash → planning rewind).
 */
export function preferArtifactSnapshot(
  current?: ArtifactStatusSnapshot,
  incoming?: ArtifactStatusSnapshot,
): ArtifactStatusSnapshot | undefined {
  if (!incoming) {
    return current;
  }
  if (!current) {
    return incoming;
  }
  if (current.id && incoming.id && current.id !== incoming.id) {
    return incoming;
  }

  const currentTerminal = isArtifactSnapshotTerminal(current);
  const incomingTerminal = isArtifactSnapshotTerminal(incoming);
  if (currentTerminal && !incomingTerminal) {
    return current;
  }
  if (incomingTerminal && !currentTerminal) {
    return mergeArtifactSnapshotStepDetail(incoming, current);
  }

  const currentTs = Date.parse(current.updatedAt ?? "") || 0;
  const incomingTs = Date.parse(incoming.updatedAt ?? "") || 0;
  if (incomingTs !== currentTs) {
    return incomingTs >= currentTs
      ? mergeArtifactSnapshotStepDetail(incoming, current)
      : mergeArtifactSnapshotStepDetail(current, incoming);
  }

  const currentProgress =
    typeof (current.payloadJson as { generation?: { progress?: unknown } })
      ?.generation?.progress === "number"
      ? (
          current.payloadJson as {
            generation: { progress: number };
          }
        ).generation.progress
      : -1;
  const incomingProgress =
    typeof (incoming.payloadJson as { generation?: { progress?: unknown } })
      ?.generation?.progress === "number"
      ? (
          incoming.payloadJson as {
            generation: { progress: number };
          }
        ).generation.progress
      : -1;
  if (incomingProgress !== currentProgress) {
    return incomingProgress >= currentProgress
      ? mergeArtifactSnapshotStepDetail(incoming, current)
      : mergeArtifactSnapshotStepDetail(current, incoming);
  }

  return mergeArtifactSnapshotStepDetail(incoming, current);
}

export function resolveToolCallArtifactId(output: unknown) {
  return (
    getToolOutputField(output, "artifact_id") ??
    getToolOutputField(output, "artifactId") ??
    undefined
  );
}

export function isToolOutputClaimingInProgress(output: unknown) {
  const status = getToolOutputField(output, "status");
  return (
    status === "pending" || status === "running" || status === "processing"
  );
}

function isLooseToolCallRecord(value: unknown): value is ToolCallRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.tool === "string";
}

export function resolveMessageToolCalls(message: {
  metadata?: Record<string, unknown>;
  toolCalls?: ToolCallRecord[];
}) {
  if (message.toolCalls && message.toolCalls.length > 0) {
    return message.toolCalls;
  }
  const raw = message.metadata?.toolCalls;
  if (!Array.isArray(raw)) {
    return [] as ToolCallRecord[];
  }
  return raw.filter(isLooseToolCallRecord);
}
