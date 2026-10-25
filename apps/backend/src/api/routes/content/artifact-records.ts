import type { Context, Hono } from "hono";
import {
  ARTIFACT_RECORD_LIMITS,
  artifactRecordRequestSchema,
} from "@sourceweft/contracts/artifact-records";
import {
  artifactRecordError,
  artifactRecordsService,
} from "../../../modules/artifact-records";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { requireRouteParam } from "./helpers";

/**
 * Only the SourceWeft host calls these routes; a sandboxed artifact page has
 * `connect-src 'none'` and reaches storage through the host's bridge instead.
 * Two cheap checks keep it that way even if a browser ever let a page through:
 * an opaque (`null`) origin is refused outright, and every mutation must be
 * `application/json`, which a cross-site form cannot send without a CORS
 * preflight the API answers only for trusted origins. DELETE is never a simple
 * cross-site request, so it needs only the origin check.
 */
function rejectOpaqueOrigin(c: Context) {
  if (c.req.header("origin") === "null")
    throw artifactRecordError(
      "forbidden",
      "Requests from an opaque origin are refused",
    );
}

/**
 * Reads at most `requestBytes` of the body and stops there. `Content-Length`
 * is only a hint (a chunked or understated request carries no usable one), so
 * the limit is enforced on the bytes actually received, and an oversized
 * request is cancelled instead of being buffered whole.
 */
async function readBoundedText(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > ARTIFACT_RECORD_LIMITS.requestBytes) {
      await reader.cancel().catch(() => undefined);
      throw artifactRecordError("invalid_request", "The request is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readHostJsonBody(c: Context): Promise<unknown> {
  rejectOpaqueOrigin(c);
  const contentType = c.req
    .header("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json")
    throw artifactRecordError(
      "invalid_request",
      "Send the request as application/json",
    );
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > ARTIFACT_RECORD_LIMITS.requestBytes)
    throw artifactRecordError("invalid_request", "The request is too large");
  const text = await readBoundedText(c.req.raw);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw ApiError.invalidJson();
  }
}

export function versionInput(c: Context, userId: string) {
  return {
    workspaceId: requireRouteParam(c, "workspaceId"),
    artifactId: requireRouteParam(c, "id"),
    versionId: requireRouteParam(c, "versionId"),
    userId,
  };
}

export async function requireUserId(c: Context) {
  const session = await requireSession(c);
  if (!session) throw ApiError.unauthorized();
  return getSessionUserId(session);
}

export function registerArtifactRecordRoutes(app: Hono) {
  app.post("/artifacts/:id/records", async (c) => {
    const userId = await requireUserId(c);
    const parsed = artifactRecordRequestSchema.safeParse(
      await readHostJsonBody(c),
    );
    if (!parsed.success)
      throw artifactRecordError(
        "invalid_request",
        "The storage request is not valid",
        {
          issues: parsed.error.issues.slice(0, 5).map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      );
    const result = await artifactRecordsService.execute({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      userId,
      versionId: parsed.data.versionId,
      operation: parsed.data.operation,
    });
    c.header("Cache-Control", "private, no-store");
    return ApiResponse.success(c, result);
  });

  app.get("/artifacts/:id/versions/:versionId/records/status", async (c) => {
    const userId = await requireUserId(c);
    c.header("Cache-Control", "private, no-store");
    return ApiResponse.success(
      c,
      await artifactRecordsService.status(versionInput(c, userId)),
    );
  });

  app.post("/artifacts/:id/versions/:versionId/records/approval", async (c) => {
    const userId = await requireUserId(c);
    await readHostJsonBody(c);
    return ApiResponse.success(
      c,
      await artifactRecordsService.approveShared(versionInput(c, userId)),
    );
  });

  app.delete(
    "/artifacts/:id/versions/:versionId/records/approval",
    async (c) => {
      const userId = await requireUserId(c);
      rejectOpaqueOrigin(c);
      return ApiResponse.success(
        c,
        await artifactRecordsService.revokeShared(versionInput(c, userId)),
      );
    },
  );

  app.post("/artifacts/:id/versions/:versionId/records/consent", async (c) => {
    const userId = await requireUserId(c);
    await readHostJsonBody(c);
    return ApiResponse.success(
      c,
      await artifactRecordsService.grantConsent(versionInput(c, userId)),
    );
  });
}
