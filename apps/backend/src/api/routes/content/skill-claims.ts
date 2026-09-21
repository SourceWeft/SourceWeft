import type { Hono } from "hono";
import {
  parseSkillClaimRepo,
  startSkillClaimRequestSchema,
} from "@sourceweft/contracts";
import { requireSkillWorkspace } from "../../../modules/skills/registry/permissions";
import {
  getSkillClaimsOverview,
  removeClaimedRepoFromMarket,
  startSkillClaim,
  verifySkillClaim,
} from "../../../modules/skills/market/claims";
import { logger } from "../../../shared/logger";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { requireRouteParam } from "./helpers";

/**
 * An author claiming the GitHub repository their community skills come from
 * (`modules/skills/market/claims.ts`). A claim belongs to the person, not the
 * workspace: the workspace in the path only establishes that the caller can
 * see skills at all, and every claim route acts on the caller's own claims.
 */

async function resolveClaimant(c: import("hono").Context) {
  const session = await requireSession(c);
  if (!session) throw ApiError.unauthorized();
  const userId = getSessionUserId(session);
  await requireSkillWorkspace({
    workspaceId: requireRouteParam(c, "workspaceId"),
    userId,
    permission: "skills.read",
  });
  return userId;
}

export function registerSkillClaimRoutes(app: Hono) {
  // The user's claims and suggestions; with `?repo=owner/repo` or
  // `?skillId=`, also where that one repository stands.
  app.get("/skills/claims", async (c) => {
    const userId = await resolveClaimant(c);
    const rawRepo = c.req.query("repo");
    const repo = rawRepo === undefined ? null : parseSkillClaimRepo(rawRepo);
    if (rawRepo !== undefined && !repo) {
      throw ApiError.validation({ repo: "Expected owner/repo" });
    }
    const skillId = c.req.query("skillId")?.trim() || null;
    return ApiResponse.success(
      c,
      await getSkillClaimsOverview({ userId, repo, skillId }),
    );
  });

  app.post("/skills/claims", async (c) => {
    const userId = await resolveClaimant(c);
    const parsed = startSkillClaimRequestSchema.safeParse(
      await c.req.json().catch(() => {
        throw ApiError.invalidJson();
      }),
    );
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    const result = await startSkillClaim({ userId, ...parsed.data });
    logger.info("Skill repository claim started", {
      userId,
      claimId: result.claim.id,
      repo: result.claim.repo,
      method: result.claim.method,
      status: result.claim.status,
    });
    // 201 for a claim waiting on its file; 200 when it was decided at once.
    return ApiResponse.success(
      c,
      result,
      result.claim.status === "pending" ? 201 : 200,
    );
  });

  app.post("/skills/claims/:claimId/verify", async (c) => {
    const userId = await resolveClaimant(c);
    const claimId = requireRouteParam(c, "claimId");
    const claim = await verifySkillClaim({ userId, claimId });
    logger.info("Skill repository claim verified", {
      userId,
      claimId,
      repo: claim.repo,
    });
    return ApiResponse.success(c, { claim });
  });

  app.post("/skills/claims/:claimId/remove-from-market", async (c) => {
    const userId = await resolveClaimant(c);
    const claimId = requireRouteParam(c, "claimId");
    const result = await removeClaimedRepoFromMarket({ userId, claimId });
    logger.info("Claimed repository removed from the market by its author", {
      userId,
      claimId,
      ...result,
    });
    return ApiResponse.success(c, result);
  });
}
