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
    case "waiting":
    case "paused":
    case "delayed":
    case "waiting-children":
      return "queued";
    default:
      return "queued";
  }
}
