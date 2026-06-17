export function buildVideoPresentationRequestKey(input: {
  readonly threadId: string;
  readonly userMessageId: string;
  readonly workspaceId: string;
}): string {
  return [
    "video_presentation",
    input.workspaceId,
    input.threadId,
    input.userMessageId,
  ].join(":");
}
