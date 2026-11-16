import type { Context, Hono } from "hono";
import { studyGenerateRequestSchema } from "@sourceweft/contracts/study";
import {
  estimateStudy,
  getStudyFreshness,
  requestStudyArtifact,
  requestStudyRegeneration,
  studyRegenerateRequestSchema,
} from "../../../modules/study/requests";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { requireRouteParam } from "./helpers";

/** The requester's UI language, for output when the sources are mixed. */
function uiLocaleOf(c: Context) {
  const first = c.req.header("accept-language")?.split(",")[0]?.split(";")[0]?.trim();
  return first && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(first) ? first : "en";
}

async function sessionUser(c: Context) {
  const session = await requireSession(c);
  if (!session) throw ApiError.unauthorized();
  return getSessionUserId(session);
}

async function parseBody<T>(
  c: Context,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } } },
) {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw ApiError.validation(parsed.error.flatten() as Record<string, unknown>);
  }
  return parsed.data;
}

/** Generation of study artifacts (flashcards, quizzes, mind maps). */
export function registerStudyRoutes(app: Hono) {
  app.post("/study/estimate", async (c) => {
    const userId = await sessionUser(c);
    const request = await parseBody(c, studyGenerateRequestSchema);
    return ApiResponse.success(
      c,
      await estimateStudy({
        workspaceId: requireRouteParam(c, "workspaceId"),
        userId,
        uiLocale: uiLocaleOf(c),
        request,
      }),
    );
  });

  app.post("/study/artifacts", async (c) => {
    const userId = await sessionUser(c);
    const request = await parseBody(c, studyGenerateRequestSchema);
    return ApiResponse.success(
      c,
      await requestStudyArtifact({
        workspaceId: requireRouteParam(c, "workspaceId"),
        userId,
        uiLocale: uiLocaleOf(c),
        request,
      }),
      202,
    );
  });

  app.post("/study/artifacts/:id/regenerate", async (c) => {
    const userId = await sessionUser(c);
    const body = await parseBody(c, studyRegenerateRequestSchema);
    return ApiResponse.success(
      c,
      await requestStudyRegeneration({
        workspaceId: requireRouteParam(c, "workspaceId"),
        artifactId: requireRouteParam(c, "id"),
        userId,
        uiLocale: uiLocaleOf(c),
        body,
      }),
      202,
    );
  });

  app.get("/study/artifacts/:id/freshness", async (c) => {
    const userId = await sessionUser(c);
    return ApiResponse.success(
      c,
      await getStudyFreshness({
        workspaceId: requireRouteParam(c, "workspaceId"),
        artifactId: requireRouteParam(c, "id"),
        userId,
      }),
    );
  });
}
