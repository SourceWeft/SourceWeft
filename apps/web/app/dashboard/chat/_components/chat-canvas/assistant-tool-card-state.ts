/**
 * Canonical tool-card status keys. These are the control values callers switch
 * on (auto-open, icon selection); the user-facing text lives only in
 * TOOL_STATUS_LABELS so renaming a label can never silently change behavior.
 */
export type ToolStatusKey =
  | "running"
  | "generating"
  | "needs-approval"
  | "failed"
  | "rejected"
  | "done";

export const TOOL_STATUS_LABELS: Record<ToolStatusKey, string> = {
  running: "Running",
  generating: "Generating",
  "needs-approval": "Needs approval",
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
