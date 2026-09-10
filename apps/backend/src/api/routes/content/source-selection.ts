import type { Hono } from "hono";
import { updateThreadSourceSelectionRequestSchema } from "@sourceweft/contracts";
import {
  getThreadSourceSelection,
  updateThreadSourceSelection,
} from "../../../modules/threads/source-selection-service";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { requireRouteParam } from "./helpers";

export function registerSourceSelectionRoutes(app: Hono) {
  app.get("/threads/:id/source-selection", async (c) => {
    const session = await requireSession(c);
    if (!session) throw ApiError.unauthorized();
    return ApiResponse.success(
      c,
      await getThreadSourceSelection({
        workspaceId: requireRouteParam(c, "workspaceId"),
        threadId: requireRouteParam(c, "id"),
        userId: getSessionUserId(session),
      }),
    );
  });
  app.put("/threads/:id/source-selection", async (c) => {
    const session = await requireSession(c);
    if (!session) throw ApiError.unauthorized();
    const parsed = updateThreadSourceSelectionRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    return ApiResponse.success(
      c,
      await updateThreadSourceSelection({
        workspaceId: requireRouteParam(c, "workspaceId"),
        threadId: requireRouteParam(c, "id"),
        userId: getSessionUserId(session),
        ...parsed.data,
      }),
    );
  });
}
