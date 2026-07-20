import type { Hono } from "hono";
import { respondAgentConfirmationRequestSchema } from "@sourceweft/contracts";
import { toolConfirmationRunner } from "../../../modules/agent-confirmations/runner";
import { durableChatRunService } from "../../../modules/threads";
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

    const run = await durableChatRunService.validateConfirmationResponse({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      confirmationId: requireRouteParam(c, "confirmationId"),
      threadRunId: parsed.data.threadRunId,
      assistantMessageId: parsed.data.assistantMessageId,
    });

    const result = await toolConfirmationRunner.respond({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      confirmationId: requireRouteParam(c, "confirmationId"),
      confirmation: parsed.data.confirmation,
      decision: parsed.data.decision,
      editedArgs: parsed.data.editedArgs,
      note: parsed.data.note,
      trust: parsed.data.trust,
    });
    await durableChatRunService.recordConfirmationResponse({
      run,
      confirmationId: requireRouteParam(c, "confirmationId"),
      confirmation: result.confirmation,
    });
    return ApiResponse.success(c, result);
  });

  // A standing approval the user cannot see or cancel would be an invisible
  // bypass of the confirmation prompt, so these two routes are a hard
  // precondition for `approve_always` being offered anywhere in the product.
  app.get("/agent-tool-trust-rules", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }
    return ApiResponse.success(
      c,
      await toolConfirmationRunner.listTrustRules({
        workspaceId: requireRouteParam(c, "workspaceId"),
        userId: getSessionUserId(session),
      }),
    );
  });

  app.post("/agent-tool-trust-rules/:trustRuleId/revoke", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }
    return ApiResponse.success(
      c,
      await toolConfirmationRunner.revokeTrustRule({
        workspaceId: requireRouteParam(c, "workspaceId"),
        userId: getSessionUserId(session),
        trustRuleId: requireRouteParam(c, "trustRuleId"),
      }),
    );
  });
}
