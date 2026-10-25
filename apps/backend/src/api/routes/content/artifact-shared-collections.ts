import type { Hono } from "hono";
import { listArtifactShareCollections } from "../../../modules/sharing/shared-collections";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { requireRouteParam } from "./helpers";

/** Same not_found/forbidden shape as the artifact share routes. */
export function registerArtifactSharedCollectionRoutes(app: Hono) {
  app.get("/artifacts/:id/records/collections", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await listArtifactShareCollections({
      workspaceId: requireRouteParam(c, "workspaceId"),
      artifactId: requireRouteParam(c, "id"),
      userId: getSessionUserId(session),
    });
    if (!result.ok) {
      if (result.reason === "forbidden") {
        throw ApiError.forbidden(
          "Only the artifact's creator or a workspace admin can list its public collections.",
        );
      }
      throw new ApiError(404, "ARTIFACT_NOT_FOUND", "Artifact not found");
    }

    return ApiResponse.success(c, { collections: result.value });
  });
}
