import { Hono } from "hono";
import { updateUserSettingsRequestSchema } from "@sourceweft/contracts";
import { userSettingsService } from "../../modules/user-settings";
import { getSessionUserId, requireSession } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";
import { ensureObjectBody } from "./content/helpers";

export function registerUserSettingsRoutes(app: Hono) {
  const routes = new Hono();

  routes.get("/settings", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await userSettingsService.getUserSettings({
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  routes.patch("/settings", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = updateUserSettingsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await userSettingsService.updateUserSettings({
      userId: getSessionUserId(session),
      patch: parsed.data,
    });

    return ApiResponse.success(c, result);
  });

  app.route("/v1/user", routes);
}
