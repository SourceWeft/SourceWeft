import type { Context, Hono } from "hono";
import {
  artifactRecordCollectionSchema,
  artifactRecordScopeSchema,
} from "@sourceweft/contracts/artifact-records";
import {
  artifactRecordError,
  artifactRecordsExportService,
} from "../../../modules/artifact-records";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { rejectOpaqueOrigin } from "./artifact-records";
import { requireRouteParam } from "./helpers";

/** `scope` is required: which data to touch is never a default. */
function dataInput(c: Context, userId: string) {
  const scope = artifactRecordScopeSchema.safeParse(c.req.query("scope"));
  if (!scope.success)
    throw artifactRecordError(
      "invalid_request",
      "scope must be user or shared",
    );
  const rawCollection = c.req.query("collection");
  const collection =
    rawCollection === undefined
      ? undefined
      : artifactRecordCollectionSchema.safeParse(rawCollection);
  if (collection && !collection.success)
    throw artifactRecordError(
      "invalid_request",
      "collection is not a valid collection name",
    );
  return {
    workspaceId: requireRouteParam(c, "workspaceId"),
    artifactId: requireRouteParam(c, "id"),
    userId,
    scope: scope.data,
    collection: collection?.data,
  };
}

async function requireUserId(c: Context) {
  const session = await requireSession(c);
  if (!session) throw ApiError.unauthorized();
  return getSessionUserId(session);
}

/**
 * Data export and clearing for the people who own page data. The role guard
 * leaves `/artifacts/:id/records` to its handler (plane "none"), so every
 * rule, including who may touch `shared` data, lives in the service.
 */
export function registerArtifactRecordExportRoutes(app: Hono) {
  app.get("/artifacts/:id/records/export", async (c) => {
    const userId = await requireUserId(c);
    rejectOpaqueOrigin(c);
    const { filename, stream } = await artifactRecordsExportService.export(
      dataInput(c, userId),
    );
    return c.body(stream, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
  });

  app.delete("/artifacts/:id/records", async (c) => {
    const userId = await requireUserId(c);
    rejectOpaqueOrigin(c);
    const result = await artifactRecordsExportService.clear(
      dataInput(c, userId),
    );
    c.header("Cache-Control", "private, no-store");
    return ApiResponse.success(c, result);
  });
}
