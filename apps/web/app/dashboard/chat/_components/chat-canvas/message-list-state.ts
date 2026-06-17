export function shouldShowAssistantLiveThinking(input: {
  isCancelled?: boolean;
  isStreaming: boolean;
}) {
  return input.isStreaming && input.isCancelled !== true;
}

export function shouldShowAssistantBottomLoading(input: {
  isCancelled?: boolean;
  isStreaming: boolean;
  isTextPaused?: boolean;
  threadRunStatus?: string;
}) {
  return (
    input.isStreaming &&
    input.isCancelled !== true &&
    input.isTextPaused !== true &&
    input.threadRunStatus !== "waiting_for_approval"
  );
}
