export type ApiJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export function mapBullMqStateToStatus(state: string): ApiJobStatus {
  switch (state) {
    case "active":
      return "running";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "removed":
      return "cancelled";
    case "waiting":
    case "paused":
    case "delayed":
    case "waiting-children":
      return "queued";
    default:
      return "queued";
  }
}

export function presentJobState(input: {
  id: string;
  type: string;
  state: string;
  createdAtMs: number;
  processedAtMs?: number;
  finishedAtMs?: number;
  returnvalue?: unknown;
  failedReason?: string;
  progress?: unknown;
}) {
  const updatedAtMs = input.finishedAtMs ?? input.processedAtMs ?? input.createdAtMs;

  return {
    id: input.id,
    type: input.type,
    status: mapBullMqStateToStatus(input.state),
    createdAt: new Date(input.createdAtMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    progress: input.progress ?? null,
    result: input.returnvalue ?? null,
    error: input.failedReason ?? null,
  };
}
