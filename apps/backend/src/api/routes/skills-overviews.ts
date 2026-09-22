import {
  previewSkillAnalysis,
  enqueueSkillAnalysisBatch,
} from "../../modules/skills/market/analysis-admin";
import type { Hono } from "hono";
import {
  skillAnalysisPreviewResponseSchema,
  skillAnalysisBatchRequestSchema,
  skillAnalysisBatchResponseSchema,
  getSkillOverviewAdminResponseSchema,
  getSkillOverviewBillingResponseSchema,
  putSkillOverviewBillingRequestSchema,
  regenerateSkillOverviewResponseSchema,
  setSkillOverviewVisibilityRequestSchema,
  setSkillOverviewVisibilityResponseSchema,
  skillOverviewStatusResponseSchema,
} from "@sourceweft/contracts";
import {
  getSkillOverviewStatus,
  regenerateSkillOverview,
  setSkillOverviewBilling,
  setSkillOverviewVisibility,
} from "../../modules/skills/market/overview-admin";
import {
  findSkillOverviewAdminState,
  readSkillOverviewBilling,
} from "../../modules/skills/market/overview-repository";
import { logger } from "../../shared/logger";
import { getSessionUserId } from "../middleware/auth-session";
import { ApiError, ApiResponse } from "../response/api-response";
import { requireSkillMarketAdmin } from "./skills-market-admin";

/**
 * Skill market AI overviews (§17.4), the market admin's side: who the model
 * calls are billed to, coverage, and one skill's overview — read,
 * regenerated, hidden. The public side is the `locale` query and the
 * `aiSummary`/`aiOverview` fields of `skills-public.ts`.
 */

const BILLING_PROBLEMS = {
  workspace_not_found: "No live workspace with this id",
  workspace_not_in_team: "The workspace does not belong to this team",
  user_not_member: "The billed user is not a member of this workspace",
} as const;

async function readJson(c: { req: { json: () => Promise<unknown> } }) {
  return c.req.json().catch(() => {
    throw ApiError.invalidJson();
  });
}

export function registerSkillOverviewRoutes(app: Hono) {
  app.get("/v1/skills/registry/admin/settings/overview-billing", async (c) => {
    await requireSkillMarketAdmin(c);
    const stored = await readSkillOverviewBilling();
    return ApiResponse.success(
      c,
      getSkillOverviewBillingResponseSchema.parse({
        billing: stored.billing,
        updatedBy: stored.updatedBy,
        updatedAt: stored.updatedAt?.toISOString() ?? null,
      }),
    );
  });

  app.put("/v1/skills/registry/admin/settings/overview-billing", async (c) => {
    const session = await requireSkillMarketAdmin(c);
    const actorUserId = getSessionUserId(session);
    const parsed = putSkillOverviewBillingRequestSchema.safeParse(
      await readJson(c),
    );
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    const result = await setSkillOverviewBilling({
      teamId: parsed.data.teamId,
      workspaceId: parsed.data.workspaceId,
      // Never a user nobody named: the admin making the change, unless they
      // named another member.
      userId: parsed.data.userId ?? actorUserId,
      actorUserId,
    });
    if (!result.ok) {
      throw new ApiError(
        400,
        "SKILL_OVERVIEW_BILLING_INVALID",
        BILLING_PROBLEMS[result.problem],
        { problem: result.problem },
      );
    }
    logger.info("Skill overview billing set", {
      actorUserId,
      ...result.billing,
    });
    const stored = await readSkillOverviewBilling();
    return ApiResponse.success(
      c,
      getSkillOverviewBillingResponseSchema.parse({
        billing: stored.billing,
        updatedBy: stored.updatedBy,
        updatedAt: stored.updatedAt?.toISOString() ?? null,
      }),
    );
  });

  app.get("/v1/skills/registry/admin/overviews/preview", async (c) => {
    await requireSkillMarketAdmin(c);
    const cursor = c.req.query("cursor");
    if (cursor && cursor.length > 200) throw ApiError.invalidJson();
    return ApiResponse.success(
      c,
      skillAnalysisPreviewResponseSchema.parse(
        await previewSkillAnalysis(cursor),
      ),
    );
  });
  app.post("/v1/skills/registry/admin/overviews/batch", async (c) => {
    const session = await requireSkillMarketAdmin(c);
    const parsed = skillAnalysisBatchRequestSchema.safeParse(await readJson(c));
    if (!parsed.success)
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    return ApiResponse.success(
      c,
      skillAnalysisBatchResponseSchema.parse(
        await enqueueSkillAnalysisBatch(
          parsed.data.skillVersionIds,
          getSessionUserId(session),
        ),
      ),
    );
  });

  app.get("/v1/skills/registry/admin/overviews/status", async (c) => {
    await requireSkillMarketAdmin(c);
    return ApiResponse.success(
      c,
      skillOverviewStatusResponseSchema.parse(await getSkillOverviewStatus()),
    );
  });

  app.get("/v1/skills/registry/admin/skills/:skillId/overview", async (c) => {
    await requireSkillMarketAdmin(c);
    const state = await findSkillOverviewAdminState(c.req.param("skillId"));
    if (!state) throw ApiError.notFound("Skill not found");
    return ApiResponse.success(
      c,
      getSkillOverviewAdminResponseSchema.parse({
        ...state,
        analysis: state.analysis
          ? {
              ...state.analysis,
              updatedAt: state.analysis.updatedAt.toISOString(),
            }
          : null,
        overviews: state.overviews.map((entry) => ({
          ...entry,
          generatedAt: entry.generatedAt.toISOString(),
        })),
      }),
    );
  });

  app.post(
    "/v1/skills/registry/admin/skills/:skillId/overview/regenerate",
    async (c) => {
      const session = await requireSkillMarketAdmin(c);
      const actorUserId = getSessionUserId(session);
      const result = await regenerateSkillOverview({
        skillId: c.req.param("skillId"),
        actorUserId,
      });
      if (!result) {
        throw ApiError.notFound("No current version of a skill with this id");
      }
      logger.info("Skill overview regenerate requested", {
        actorUserId,
        ...result,
      });
      return ApiResponse.success(
        c,
        regenerateSkillOverviewResponseSchema.parse(result),
      );
    },
  );

  app.post(
    "/v1/skills/registry/admin/skills/:skillId/overview/visibility",
    async (c) => {
      const session = await requireSkillMarketAdmin(c);
      const actorUserId = getSessionUserId(session);
      const parsed = setSkillOverviewVisibilityRequestSchema.safeParse(
        await readJson(c),
      );
      if (!parsed.success) {
        throw ApiError.validation(
          parsed.error.flatten() as Record<string, unknown>,
        );
      }
      const result = await setSkillOverviewVisibility({
        skillId: c.req.param("skillId"),
        hidden: parsed.data.hidden,
        actorUserId,
      });
      if (!result) {
        throw ApiError.notFound("This skill's current version has no overview");
      }
      return ApiResponse.success(
        c,
        setSkillOverviewVisibilityResponseSchema.parse(result),
      );
    },
  );
}
