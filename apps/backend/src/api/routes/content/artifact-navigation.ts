import type { Hono } from "hono";
import { artifactRecordsService } from "../../../modules/artifact-records";
import { ApiResponse } from "../../response/api-response";
import {
  readHostJsonBody,
  requireUserId,
  versionInput,
} from "./artifact-records";

/**
 * The host reports that a rendered page tried to leave its frame. Same
 * host-only guards as the approval and consent routes. The body is read and
 * discarded: the report carries nothing from the page, and the destination is
 * never known to the host either.
 */
export function registerArtifactNavigationRoutes(app: Hono) {
  app.post(
    "/artifacts/:id/versions/:versionId/records/navigation",
    async (c) => {
      const userId = await requireUserId(c);
      await readHostJsonBody(c);
      c.header("Cache-Control", "private, no-store");
      return ApiResponse.success(
        c,
        await artifactRecordsService.reportNavigation(versionInput(c, userId)),
      );
    },
  );
}
