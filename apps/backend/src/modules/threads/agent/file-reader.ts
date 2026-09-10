import { createHash } from "node:crypto";
import { fileRelativePathSchema, type FileRef } from "@sourceweft/contracts";
import type { BackendProtocolV2 } from "deepagents";
import { ContentError } from "../../content/errors";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function fileMimeType(path: string, bytes: Uint8Array): string {
  const content = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    content
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (content[0] === 255 && content[1] === 216 && content[2] === 255)
    return "image/jpeg";
  if (
    content.subarray(0, 4).toString() === "RIFF" &&
    content.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (/^GIF8[79]a$/.test(content.subarray(0, 6).toString())) return "image/gif";
  if (content.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (
    /\.(js|jsx|ts|tsx|py|go|rs|java|c|h|cpp|css|html|xml|yaml|yml|toml|sh|sql|log|ini|env)$/i.test(
      path,
    )
  )
    return "text/plain";
  return (
    MIME[path.split(".").pop()?.toLowerCase() ?? ""] ??
    "application/octet-stream"
  );
}

export function createFileReader(input: {
  backend: Pick<BackendProtocolV2, "downloadFiles">;
  root: string;
  backendKind: FileRef["backendKind"];
  scopeId: string;
  signal?: AbortSignal;
  download?: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<
    | Uint8Array
    | {
        bytes: Uint8Array;
        metadata: {
          fileId: string;
          origin: FileRef["origin"];
          revision: string;
        };
      }
  >;
}) {
  const root = input.root.replace(/\/+$/, "");
  return async (
    path: string,
    requestedSignal?: AbortSignal,
  ): Promise<{ file: FileRef; bytes: Buffer }> => {
    const signal =
      requestedSignal && input.signal
        ? AbortSignal.any([requestedSignal, input.signal])
        : (requestedSignal ?? input.signal);
    signal?.throwIfAborted();
    const relative = path.startsWith(`${root}/`)
      ? path.slice(root.length + 1)
      : path;
    const checked = fileRelativePathSchema.safeParse(relative);
    if (!checked.success)
      throw new ContentError(
        403,
        "FILE_SCOPE_DENIED",
        "Choose a file inside this conversation's Files.",
      );
    if (!input.download && !input.backend.downloadFiles)
      throw new ContentError(
        409,
        "FILE_READ_UNAVAILABLE",
        "File byte access is unavailable.",
      );
    const absolutePath = `${root}/${checked.data}`;
    const downloaded = input.download
      ? await input.download(absolutePath, signal)
      : undefined;
    const metadata =
      downloaded && "bytes" in downloaded ? downloaded.metadata : undefined;
    const result = downloaded
      ? {
          path: absolutePath,
          content: "bytes" in downloaded ? downloaded.bytes : downloaded,
          error: null,
        }
      : (await input.backend.downloadFiles!([absolutePath]))[0];
    signal?.throwIfAborted();
    if (!result || result.error || result.content === null)
      throw new ContentError(
        404,
        "FILE_UNAVAILABLE",
        String(result?.error ?? "File is unavailable"),
      );
    const bytes = Buffer.from(result.content);
    if (bytes.length > 20 * 1024 * 1024)
      throw new ContentError(
        413,
        "FILE_TOO_LARGE",
        "File reads are limited to 20 MiB.",
      );
    const revision = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (metadata && metadata.revision !== revision)
      throw new ContentError(
        409,
        "FILE_CHANGED",
        "File metadata does not match the bytes read.",
      );
    const mimeType = fileMimeType(checked.data, bytes);
    const text =
      mimeType.startsWith("text/") || mimeType === "application/json";
    return {
      bytes,
      file: {
        scopeKind: "files",
        backendKind: input.backendKind,
        fileId:
          metadata?.fileId ??
          createHash("sha256")
            .update(JSON.stringify([input.scopeId, root, checked.data]))
            .digest("hex"),
        relativePath: checked.data,
        name: checked.data.split("/").pop()!,
        mimeType,
        sizeBytes: bytes.length,
        revision,
        origin: metadata?.origin ?? "unknown",
        capabilities: {
          readText: text,
          searchText: text,
          viewImage: mimeType.startsWith("image/"),
          readDocument:
            text ||
            ["pdf", "docx", "pptx", "xlsx"].includes(
              checked.data.split(".").pop()?.toLowerCase() ?? "",
            ),
          write: true,
        },
      },
    };
  };
}

export type ScopedFileReader = ReturnType<typeof createFileReader>;
