import { eq } from "drizzle-orm";
import { db, threads, localThreadBindings } from "@sourceweft/db";
import { ApiError } from "../../api/response/api-response";
import { ContentError } from "../content/errors";
import { localCall } from "./service";
import type { LocalExecutionCaller } from "./access";

/** A read-only physical probe: never allocates or repairs the working directory. */
export async function requireLocalConversationReady(input: {
  userId: string;
  workspaceId: string;
  threadId: string;
  localCaller?: LocalExecutionCaller;
  resolveCaller?: () => Promise<LocalExecutionCaller>;
}) {
  const thread = await db.query.threads.findFirst({
    where: eq(threads.id, input.threadId),
  });
  if (!thread || thread.workspaceId !== input.workspaceId)
    throw new ContentError(404, "THREAD_NOT_FOUND", "Conversation not found.");
  if (thread.executionTargetJson.kind !== "local") return;
  if (thread.createdBy !== input.userId || thread.visibility !== "private")
    throw new ContentError(
      403,
      "LOCAL_THREAD_FORBIDDEN",
      "This local conversation is private to its owner.",
    );
  const binding = await db.query.localThreadBindings.findFirst({
    where: eq(localThreadBindings.threadId, thread.id),
  });
  if (
    !binding ||
    binding.userId !== input.userId ||
    binding.deviceId !== thread.executionTargetJson.deviceId
  )
    throw new ContentError(
      409,
      "LOCAL_BINDING_INVALID",
      "The computer binding is unavailable.",
    );
  try {
    const result = await localCall({
      userId: input.userId,
      threadId: thread.id,
      deviceId: binding.deviceId,
      caller: input.localCaller ?? (await input.resolveCaller?.()),
      action: "workspace.check",
      payload: {
        workspaceId: binding.localWorkspaceId,
        directoryGrantId:
          binding.folderId ??
          thread.executionTargetJson.directoryGrantId ??
          null,
      },
      timeoutMs: 5000,
    });
    if (result.ready !== true)
      throw new ApiError(
        409,
        "LOCAL_HOST_UPGRADE_REQUIRED",
        "The computer could not verify its working directory. Update the desktop app and reconnect.",
      );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "LOCAL_EXECUTION_FAILED"
    )
      throw new ContentError(
        409,
        "LOCAL_DIRECTORY_UNAVAILABLE",
        `The working directory could not be verified: ${error.message}`,
      );
    if (error instanceof ApiError)
      throw new ContentError(error.statusCode, error.code, error.message);
    throw error;
  }
}
