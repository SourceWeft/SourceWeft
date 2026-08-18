export function shouldShowAssistantLiveThinking(input: {
  isCancelled?: boolean;
  isStreaming: boolean;
}) {
  return input.isStreaming && input.isCancelled !== true;
}

export function shouldShowAssistantBottomLoading(input: {
  isCancelled?: boolean;
  isStreaming: boolean;
  threadRunStatus?: string;
}) {
  return (
    input.isStreaming &&
    input.isCancelled !== true &&
    input.threadRunStatus !== "waiting_for_approval"
  );
}

export function resolveAssistantFallbackActivity(input: {
  hasConcreteActiveActivity: boolean;
  isLive: boolean;
  text: string;
}): "thinking" | "responding" | null {
  if (!input.isLive || input.hasConcreteActiveActivity) {
    return null;
  }
  return input.text.trim().length > 0 ? "responding" : "thinking";
}
