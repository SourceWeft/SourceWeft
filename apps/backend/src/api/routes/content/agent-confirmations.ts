import type { Hono } from "hono";
import { respondAgentConfirmationRequestSchema } from "@sourceweft/contracts";
import { toolConfirmationRunner } from "../../../modules/agent-confirmations/runner";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

export function registerAgentConfirmationRoutes(app: Hono) {
  app.post("/agent-confirmations/:confirmationId/respond", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = respondAgentConfirmationRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await toolConfirmationRunner.respond({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      confirmationId: requireRouteParam(c, "confirmationId"),
      confirmation: parsed.data.confirmation,
      decision: parsed.data.decision,
      editedArgs: parsed.data.editedArgs,
      note: parsed.data.note,
    });
    return ApiResponse.success(c, result);
  });
}
