import { createHash } from "node:crypto";
import { jobsRedisClient } from "../../shared/queue";
import { ContentError } from "../content/errors";

type TransferScope = { userId: string; deviceId: string; invocationId: string };
function key(scope: TransferScope) {
  const id = createHash("sha256")
    .update(JSON.stringify([scope.userId, scope.deviceId, scope.invocationId]))
    .digest("hex");
  return `sourceweft:local-file-transfer:${id}`;
}

/** File bytes use a short-lived transport, never the durable invocation audit row. */
export async function storeLocalFileReply(
  scope: TransferScope,
  result: Record<string, unknown>,
) {
  if (
    typeof result.content !== "string" ||
    result.content.length > 2 * 1024 * 1024
  ) {
    throw new ContentError(
      502,
      "INVALID_FILE_REPLY",
      "The computer returned an invalid file payload.",
    );
  }
  const redis = await jobsRedisClient();
  await redis.set(key(scope), result.content, "EX", 60);
  const { content: _content, ...metadata } = result;
  return { ...metadata, contentTransport: "ephemeral" };
}

export async function consumeLocalFileReply(
  scope: TransferScope,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (result.contentTransport !== "ephemeral") {
    throw new ContentError(
      502,
      "INVALID_FILE_REPLY",
      "File bytes must use the transient transfer channel.",
    );
  }
  const redis = await jobsRedisClient();
  const content = await redis.eval(
    "local value=redis.call('GET',KEYS[1]); redis.call('DEL',KEYS[1]); return value",
    1,
    key(scope),
  );
  if (typeof content !== "string") {
    throw new ContentError(
      410,
      "FILE_TRANSFER_EXPIRED",
      "The file transfer expired. Read the file again.",
    );
  }
  const { contentTransport: _transport, ...metadata } = result;
  return { ...metadata, content };
}
