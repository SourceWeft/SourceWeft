import type { Hono } from "hono";
import { createSkillSubmissionRequestSchema } from "@sourceweft/contracts";
import {
  requireSkillWorkspace,
  type SkillPermission,
} from "../../../modules/skills/registry/permissions";
import {
  createSkillSubmission,
  decodeSkillSubmissionCursor,
  getSkillSubmission,
  listSkillSubmissions,
  retrySkillSubmission,
  SKILL_SUBMISSION_PAGE_LIMITS,
} from "../../../modules/skills/registry/ingest/service";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

/**
 * Asynchronous community-skill ingest: create a submission (the worker does
 * the GitHub read, scan and indexing), then poll it. Replaces the synchronous
 * `POST /skills/registry/submit`, which stays until its callers have moved.
 */

async function resolveViewer(
  c: import("hono").Context,
  permission: SkillPermission,
) {
  const session = await requireSession(c);
  if (!session) {
    throw ApiError.unauthorized();
  }
  const userId = getSessionUserId(session);
  const { workspace } = await requireSkillWorkspace({
    workspaceId: requireRouteParam(c, "workspaceId"),
    userId,
    permission,
  });
  return { teamId: workspace.organizationId, workspaceId: workspace.id, userId };
}

export function registerSkillSubmissionRoutes(app: Hono) {
  app.post("/skills/registry/submissions", async (c) => {
    const viewer = await resolveViewer(c, "skills.submit");
    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = createSkillSubmissionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    const { submission, created } = await createSkillSubmission({
      ...viewer,
      source: parsed.data.source,
      ...(parsed.data.install ? { install: parsed.data.install } : {}),
    });
    // 202: accepted, not done. 200 when the caller already has this source in
    // flight and is handed that record instead of a second job.
    return ApiResponse.success(c, { submission }, created ? 202 : 200);
  });

  app.get("/skills/registry/submissions", async (c) => {
    const viewer = await resolveViewer(c, "skills.read");
    const rawLimit =
      c.req.query("limit") ?? String(SKILL_SUBMISSION_PAGE_LIMITS.default);
    const limit = Number(rawLimit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > SKILL_SUBMISSION_PAGE_LIMITS.max
    ) {
      throw ApiError.validation({
        limit: `Expected integer from 1 to ${SKILL_SUBMISSION_PAGE_LIMITS.max}`,
      });
    }
    const rawCursor = c.req.query("cursor");
    const cursor =
      rawCursor === undefined
        ? undefined
        : decodeSkillSubmissionCursor(rawCursor);
    if (cursor === null) {
      throw ApiError.validation({ cursor: "Invalid cursor" });
    }
    return ApiResponse.success(
      c,
      await listSkillSubmissions({ ...viewer, limit, cursor }),
    );
  });

  app.get("/skills/registry/submissions/:submissionId", async (c) => {
    const viewer = await resolveViewer(c, "skills.read");
    return ApiResponse.success(
      c,
      await getSkillSubmission({
        ...viewer,
        submissionId: requireRouteParam(c, "submissionId"),
      }),
    );
  });

  app.post("/skills/registry/submissions/:submissionId/retry", async (c) => {
    const viewer = await resolveViewer(c, "skills.submit");
    return ApiResponse.success(
      c,
      await retrySkillSubmission({
        ...viewer,
        submissionId: requireRouteParam(c, "submissionId"),
      }),
      202,
    );
  });
}
