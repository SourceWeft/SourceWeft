import type { Context, Hono } from "hono";
import type { z } from "zod";
import {
  quizAttemptListQuerySchema,
  reviewProgressQuerySchema,
  reviewQueueQuerySchema,
  reviewRequestSchema,
  startQuizAttemptSchema,
  submitAnswersSchema,
} from "@sourceweft/contracts/study";
import {
  deriveCardsFromAttempt,
  getReviewProgress,
  getReviewQueue,
  gradeFlashcard,
  listQuizAttempts,
  saveQuizAnswers,
  startQuizAttempt,
} from "../../../modules/study/state";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { requireRouteParam } from "./helpers";

/**
 * Per-user learning state for study artifacts: flashcard review (FSRS) and
 * quiz attempts. Session only — a public share page has no learner to save
 * state for, so these answer 401 there. The workspace and team written with
 * every row come from the artifact the caller was authorized against, never
 * from the request.
 */

async function requireUser(c: Context) {
  const session = await requireSession(c);
  if (!session) throw ApiError.unauthorized();
  c.header("Cache-Control", "private, no-store");
  return {
    userId: getSessionUserId(session),
    workspaceId: requireRouteParam(c, "workspaceId"),
  };
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw ApiError.validation(parsed.error.flatten() as Record<string, unknown>);
  }
  return parsed.data;
}

async function jsonBody(c: Context) {
  return c.req.json().catch(() => {
    throw ApiError.invalidJson();
  });
}

export function registerStudyStateRoutes(app: Hono) {
  app.get("/study/review/queue", async (c) => {
    const user = await requireUser(c);
    const query = parse(reviewQueueQuerySchema, c.req.query());
    return ApiResponse.success(c, await getReviewQueue({ ...user, ...query }));
  });

  app.get("/study/artifacts/:id/progress", async (c) => {
    const user = await requireUser(c);
    return ApiResponse.success(
      c,
      await getReviewProgress({
        ...user,
        artifactId: requireRouteParam(c, "id"),
        ...parse(reviewProgressQuerySchema, c.req.query()),
      }),
    );
  });

  app.post("/study/artifacts/:id/review", async (c) => {
    const user = await requireUser(c);
    const body = parse(reviewRequestSchema, await jsonBody(c));
    return ApiResponse.success(
      c,
      await gradeFlashcard({
        ...user,
        artifactId: requireRouteParam(c, "id"),
        versionNo: body.versionNo,
        artifactVersionId: body.artifactVersionId,
        itemId: body.itemId,
        grade: body.grade,
      }),
    );
  });

  app.post("/study/artifacts/:id/quiz/attempts", async (c) => {
    const user = await requireUser(c);
    const body = parse(startQuizAttemptSchema, await jsonBody(c));
    return ApiResponse.success(
      c,
      await startQuizAttempt({
        ...user,
        artifactId: requireRouteParam(c, "id"),
        versionNo: body.versionNo,
        artifactVersionId: body.artifactVersionId,
        itemIds: body.itemIds,
      }),
      201,
    );
  });

  app.get("/study/artifacts/:id/quiz/attempts", async (c) => {
    const user = await requireUser(c);
    return ApiResponse.success(
      c,
      await listQuizAttempts({
        ...user,
        artifactId: requireRouteParam(c, "id"),
        ...parse(quizAttemptListQuerySchema, c.req.query()),
      }),
    );
  });

  app.put("/study/quiz/attempts/:attemptId", async (c) => {
    const user = await requireUser(c);
    const body = parse(submitAnswersSchema, await jsonBody(c));
    return ApiResponse.success(
      c,
      await saveQuizAnswers({
        ...user,
        attemptId: requireRouteParam(c, "attemptId"),
        answers: body.answers,
        finish: body.finish,
      }),
    );
  });

  app.post("/study/quiz/attempts/:attemptId/derive-cards", async (c) => {
    const user = await requireUser(c);
    const result = await deriveCardsFromAttempt({
      ...user,
      attemptId: requireRouteParam(c, "attemptId"),
    });
    return ApiResponse.success(c, result, result.reused ? 200 : 201);
  });
}
