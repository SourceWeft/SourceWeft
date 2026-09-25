/**
 * Canonical tool-card status keys. These are the control values callers switch
 * on (auto-open, icon selection); the user-facing text lives only in
 * TOOL_STATUS_LABELS so renaming a label can never silently change behavior.
 */
import type { ToolConfirmationResolution } from "./types";

export type ToolStatusKey =
  | "running"
  | "generating"
  | "needs-approval"
  | "not-run"
  | "failed"
  | "rejected"
  | "done";

export const TOOL_STATUS_LABELS: Record<ToolStatusKey, string> = {
  running: "Running",
  generating: "Generating",
  "needs-approval": "Needs approval",
  "not-run": "Not run",
  failed: "Failed",
  rejected: "Rejected",
  done: "Done",
};

function shouldAutoOpenToolStatus(statusKey: ToolStatusKey) {
  return statusKey !== "done";
}

export function resolveAssistantToolCardDefaultOpen(input: {
  defaultOpen?: boolean;
  hasReadFilePreview: boolean;
  statusKey: ToolStatusKey;
}) {
  return (
    input.defaultOpen ??
    (input.hasReadFilePreview || shouldAutoOpenToolStatus(input.statusKey))
  );
}

/**
 * A local confirmation outcome outranks the tool call's own status: once an
 * approval expires, goes stale, is stopped, or is rejected, the call can no
 * longer be waiting for approval even though its record still says so.
 */
export function resolveConfirmationStatusKey(input: {
  confirmationResolution?: ToolConfirmationResolution | null;
  toolCallStatus: string;
}): ToolStatusKey | null {
  const resolution = input.confirmationResolution;
  if (!resolution) {
    return null;
  }
  if (resolution.expired || resolution.stale || resolution.stopped) {
    return "not-run";
  }
  if (resolution.decision === "reject") {
    return "rejected";
  }
  if (input.toolCallStatus === "approval_requested") {
    return "running";
  }
  return null;
}

/** Statuses where the action never ran, so it has no meaningful duration. */
export function isToolStatusUnexecuted(statusKey: ToolStatusKey) {
  return (
    statusKey === "needs-approval" ||
    statusKey === "not-run" ||
    statusKey === "rejected"
  );
}
