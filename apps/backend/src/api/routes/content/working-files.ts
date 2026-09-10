import type { Context, Hono } from "hono";
import { putWorkingFileRequestSchema } from "@sourceweft/contracts";
import { workingFilesService } from "../../../modules/working-files";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

function requirePathQuery(c: Context) {
  const path = c.req.query("path")?.trim();
  if (!path) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "path query parameter is required",
    );
  }
  return path;
}

export function registerWorkingFileRoutes(app: Hono) {
  app.get("/threads/:id/files/bytes", async (c) => {
    const session = await requireSession(c);
    if (!session) throw ApiError.unauthorized();
    const { file, bytes } = await workingFilesService.readBytes({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      path: requirePathQuery(c),
      signal: c.req.raw.signal,
    });
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Type", file.mimeType);
    c.header("ETag", `"sha256:${file.contentHash}"`);
    c.header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.path.split("/").pop() ?? "file")}`,
    );
    return c.body(new Uint8Array(bytes));
  });

  app.put("/threads/:id/files/bytes", async (c) => {
    const session = await requireSession(c);
    if (!session) throw ApiError.unauthorized();
    await workingFilesService.requireThreadScope({
      workspaceId: requireRouteParam(c, "workspaceId"), threadId: requireRouteParam(c, "id"), userId: getSessionUserId(session),
    });
    const reader = c.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 20 * 1024 * 1024) {
            await reader.cancel();
            throw new ApiError(
              413,
              "FILE_TOO_LARGE",
              "Files are limited to 20 MiB.",
            );
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const expectedRevision = c.req.header("If-Match")?.replace(/^"|"$/g, "");
    if (expectedRevision && !/^sha256:[a-f0-9]{64}$/.test(expectedRevision))
      throw new ApiError(
        400,
        "INVALID_REVISION",
        "If-Match must contain a file revision.",
      );
    const result = await workingFilesService.putBytes({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      path: requirePathQuery(c),
      bytes: Buffer.concat(chunks, size),
      signal: c.req.raw.signal,
      mimeType: c.req.header("Content-Type") ?? "application/octet-stream",
      expectedRevision,
    });
    return ApiResponse.success(c, { file: result.file });
  });

  app.get("/threads/:id/files", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await workingFilesService.listWorkingFiles({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/threads/:id/files/content", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await workingFilesService.getWorkingFile({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      path: requirePathQuery(c),
    });

    return ApiResponse.success(c, result);
  });

  app.put("/threads/:id/files/content", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = putWorkingFileRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await workingFilesService.putWorkingFile({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      path: requirePathQuery(c),
      contentText: parsed.data.contentText,
      signal: c.req.raw.signal,
      expectedRevision: parsed.data.expectedRevision,
      mimeType: parsed.data.mimeType,
      purpose: parsed.data.purpose,
    });

    return ApiResponse.success(c, result);
  });

  app.delete("/threads/:id/files", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await workingFilesService.deleteWorkingFile({
      workspaceId: requireRouteParam(c, "workspaceId"),
      threadId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
      path: requirePathQuery(c),
    });

    return ApiResponse.success(c, result);
  });
}
