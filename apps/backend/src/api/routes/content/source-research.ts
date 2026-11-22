import type { Hono } from "hono";
import { researchRequestSchema } from "@sourceweft/contracts/source-research";
import type { CreateResearchResult } from "../../../modules/sources/research/service";
import {
  cancelResearch,
  createResearch,
  getResearch,
  listResearch,
} from "../../../modules/sources/research/service";
import { toResearchRun } from "../../../modules/sources/research/mapper";
import { saveResearchReportAsNote } from "../../../modules/notes";
import { billingRuntime as billingService } from "../../../billing-host/bindings";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

const LIMITED_MESSAGES: Record<
  Extract<CreateResearchResult, { kind: "limited" }>["code"],
  string
> = {
  CONCURRENCY_LIMIT:
    "A research run is already in progress. Wait for it to finish, then try again.",
  DAILY_LIMIT: "You have reached today's limit for deep research. Try again tomorrow.",
};

/** The fallback cool-off when the limiter does not say when to retry. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export function registerSourceResearchRoutes(app: Hono) {
  app.post("/source-research", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = researchRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await createResearch(
      {
        workspaceId: requireRouteParam(c, "workspaceId"),
        userId: getSessionUserId(session),
        topic: parsed.data.topic,
        requestId: crypto.randomUUID(),
      },
      { billing: billingService },
    );

    if (result.kind === "limited") {
      const retryAfterSeconds =
        result.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
      c.header("Retry-After", String(retryAfterSeconds));
      throw new ApiError(429, result.code, LIMITED_MESSAGES[result.code], {
        retryAfterSeconds,
      });
    }

    return ApiResponse.success(c, { run: toResearchRun(result.run) }, 201);
  });

  app.get("/source-research", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const runs = await listResearch({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, { runs });
  });

  app.get("/source-research/:id", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const run = await getResearch({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      id: requireRouteParam(c, "id"),
    });

    return ApiResponse.success(c, { run });
  });

  app.post("/source-research/:id/cancel", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const cancelled = await cancelResearch({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      id: requireRouteParam(c, "id"),
    });

    return ApiResponse.success(c, { cancelled });
  });

  app.post("/source-research/:id/save-note", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await saveResearchReportAsNote({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      runId: requireRouteParam(c, "id"),
    });

    return ApiResponse.success(c, result);
  });
}
