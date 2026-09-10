import { ContentError } from "../content/errors";

type Call = (
  action: string,
  payload: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<Record<string, unknown>>;

export async function readLocalBinaryFile(input: {
  call: Call;
  workspaceId: string;
  path: string;
  signal?: AbortSignal;
  onCleanupError?: (error: unknown) => void;
}): Promise<Buffer> {
  const scope = { workspaceId: input.workspaceId, path: input.path };
  input.signal?.throwIfAborted();
  const begin = await input.call("file.binary.begin", scope, {
    signal: input.signal,
  });
  const transferId = begin.transferId;
  if (typeof transferId !== "string" || !transferId || transferId.length > 256)
    throw invalidReply();
  let failed = false;
  try {
    const size = begin.sizeBytes;
    const chunkBytes = begin.chunkBytes;
    if (
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 20 * 1024 * 1024 ||
      typeof chunkBytes !== "number" ||
      !Number.isSafeInteger(chunkBytes) ||
      chunkBytes < 1 ||
      chunkBytes > 512 * 1024
    )
      throw invalidReply();
    const content = Buffer.alloc(size);
    for (let offset = 0; offset < size; offset += chunkBytes) {
      input.signal?.throwIfAborted();
      const reply = await input.call(
        "file.binary.chunk",
        { ...scope, transferId, offset },
        { signal: input.signal },
      );
      if (
        reply.transferId !== transferId ||
        reply.offset !== offset ||
        typeof reply.content !== "string"
      )
        throw invalidReply();
      const bytes = Buffer.from(reply.content, "base64");
      const expected = Math.min(chunkBytes, size - offset);
      if (
        bytes.length !== expected ||
        bytes.toString("base64") !== reply.content ||
        reply.done !== (offset + expected === size)
      )
        throw invalidReply();
      bytes.copy(content, offset);
    }
    return content;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      // Cleanup is independent of cancellation of the read itself.
      await input.call("file.binary.close", { ...scope, transferId });
    } catch (error) {
      if (!failed) throw error;
      input.onCleanupError?.(error);
    }
  }
}

function invalidReply() {
  return new ContentError(
    502,
    "INVALID_FILE_REPLY",
    "The computer returned an inconsistent file transfer.",
  );
}
