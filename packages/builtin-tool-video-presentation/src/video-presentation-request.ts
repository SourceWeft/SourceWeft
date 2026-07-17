import { createHash } from "node:crypto";

function hashObject(obj: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(obj))
    .digest("hex")
    .slice(0, 16);
}

export function buildVideoPresentationRequestKey(input: {
  readonly threadId: string;
  readonly userMessageId: string;
  readonly workspaceId: string;
  readonly modelIdentifier?: string | null;
  readonly requestFingerprint?: unknown;
}): string {
  const parts = [
    "video_presentation",
    input.workspaceId,
    input.threadId,
    input.userMessageId,
  ];
  if (input.modelIdentifier) {
    parts.push(input.modelIdentifier);
  }
  if (input.requestFingerprint !== undefined && input.requestFingerprint !== null) {
    parts.push(hashObject(input.requestFingerprint));
  }
  return parts.join(":");
}
