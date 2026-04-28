import { ContentError } from "../../errors";
import { dedupeSourceIds } from "../../source-ids";
import {
  resolveAssistantContextParentId,
  resolveThreadTurnContext,
} from "../turn/context";
import type { StreamThreadEventInput } from "../turn/service";
import type { EditThreadInput, RefreshThreadInput } from "./types";

export async function resolveRefreshThreadStreamInput(
  input: RefreshThreadInput,
): Promise<StreamThreadEventInput> {
  const { latestUserMessage, latestAssistantMessage } =
    await resolveThreadTurnContext(input);

  if (!latestUserMessage || !latestAssistantMessage) {
    throw new ContentError(
      400,
      "THREAD_REFRESH_NOT_AVAILABLE",
      "No completed assistant response available to refresh",
    );
  }

  const sourceIds = dedupeSourceIds(input.sourceIds);

  return {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    userId: input.userId,
    content: latestUserMessage.content,
    sourceIds,
    idempotencyKey: input.idempotencyKey,
    llm: input.llm,
    existingUserMessage: latestUserMessage,
    assistantMessageParentId: latestAssistantMessage.id,
    agentAssistantMessageParentId: resolveAssistantContextParentId(
      latestAssistantMessage,
    ),
  };
}

export async function resolveEditThreadStreamInput(
  input: EditThreadInput,
): Promise<StreamThreadEventInput> {
  const { latestUserMessage, latestAssistantMessage } =
    await resolveThreadTurnContext(input);

  if (!latestUserMessage) {
    throw new ContentError(
      400,
      "THREAD_EDIT_NOT_AVAILABLE",
      "No user message available to edit",
    );
  }

  const sourceIds = dedupeSourceIds(input.sourceIds);

  return {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    userId: input.userId,
    content: input.content,
    sourceIds,
    idempotencyKey: input.idempotencyKey,
    llm: input.llm,
    userMessageParentId: latestUserMessage.id,
    assistantMessageParentId: latestAssistantMessage?.id ?? null,
    agentAssistantMessageParentId: resolveAssistantContextParentId(
      latestAssistantMessage,
    ),
  };
}
