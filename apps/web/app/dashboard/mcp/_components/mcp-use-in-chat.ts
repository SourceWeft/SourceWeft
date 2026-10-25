import {
  readStoredMcpSelection,
  writeStoredMcpSelection,
} from "../../chat/_components/mcp-selection-storage";
import { chatThreadOf } from "../../../../lib/mcp-return-to";

/**
 * Select an install for chat without sending anything: add it to the chat's
 * stored MCP selection and return the chat page to open. A flow that began in
 * a chat thread goes back to that thread; otherwise a new chat opens ("current"
 * is the new-chat page's selection bucket).
 */
export function selectInstallForChat(input: {
  workspaceId: string;
  installId: string;
  origin: string | null;
}) {
  const threadId = chatThreadOf(input.origin);
  const bucket = threadId ?? "current";
  const stored = readStoredMcpSelection(input.workspaceId, bucket);
  writeStoredMcpSelection(input.workspaceId, bucket, {
    installIds: stored.installIds.includes(input.installId)
      ? stored.installIds
      : [...stored.installIds, input.installId],
    toolIds: stored.toolIds,
  });
  return threadId ? `/dashboard/chat/${threadId}` : "/dashboard/chat";
}
