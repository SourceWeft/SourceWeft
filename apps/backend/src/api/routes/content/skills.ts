import type { Hono } from "hono";
import {
  listRegistryVersions,
  switchRegistryVersion,
} from "../../../modules/skills/registry/versions";
import {
  createCustomSkillRequestSchema,
  switchSkillVersionSchema,
  createCustomSkillVersionRequestSchema,
  putCustomSkillVersionFileRequestSchema,
  enableWorkspaceSkillRequestSchema,
  listSkillsCatalogQuerySchema,
  setOwnerSkillListingRequestSchema,
  updateCustomSkillVersionRequestSchema,
  updateWorkspaceSkillRequestSchema,
} from "@sourceweft/contracts";
import { contentSkillsService } from "../../../modules/skills";
import {
  getOwnerSkillListing,
  setOwnerSkillListing,
} from "../../../modules/skills/market/listing";
import { decodeSkillCatalogCursor } from "../../../modules/skills/service";
import { isContentError } from "../../../modules/content/errors";
import { requireSkillWorkspace } from "../../../modules/skills/registry/permissions";
import { requireContentWorkspace } from "../../../modules/workspace";
import {
  getSessionUserId,
  requireSession,
} from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { logger } from "../../../shared/logger";
import { ensureObjectBody, requireRouteParam } from "./helpers";

async function resolveSkillContext(c: import("hono").Context) {
  const session = await requireSession(c);
  if (!session) {
    throw ApiError.unauthorized();
  }
  const workspace = await requireContentWorkspace({
    workspaceId: requireRouteParam(c, "workspaceId"),
    userId: getSessionUserId(session),
  });
  return {
    session,
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
  };
}

export function registerSkillRoutes(app: Hono) {
  // The owner's say over a community skill they imported: may it be on the
  // public market? Anyone else gets the same 404 as for a skill that does not
  // exist, so the route does not reveal who imported what.
  app.get("/skills/catalog/:catalogId/listing", async (c) => {
    const context = await resolveSkillContext(c);
    const [skillId = ""] = requireRouteParam(c, "catalogId").split(":");
    const listing = await getOwnerSkillListing({
      skillId,
      userId: getSessionUserId(context.session),
    });
    if (!listing) throw ApiError.notFound("Skill not found");
    return ApiResponse.success(c, listing);
  });
  app.put("/skills/catalog/:catalogId/listing", async (c) => {
    const context = await resolveSkillContext(c);
    const parsed = setOwnerSkillListingRequestSchema.safeParse(
      await c.req.json().catch(() => {
        throw ApiError.invalidJson();
      }),
    );
    if (!parsed.success) throw ApiError.validation();
    const [skillId = ""] = requireRouteParam(c, "catalogId").split(":");
    const userId = getSessionUserId(context.session);
    const listing = await setOwnerSkillListing({
      skillId,
      userId,
      listed: parsed.data.listed,
    });
    if (!listing) throw ApiError.notFound("Skill not found");
    logger.info("Skill owner changed its public listing", {
      skillId,
      userId,
      listed: parsed.data.listed,
    });
    return ApiResponse.success(c, listing);
  });
  app.get("/skills/catalog/:catalogId/versions", async (c) => {
    const context = await resolveSkillContext(c);
    const rawLimit = c.req.query("limit") ?? "20";
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw ApiError.validation({ limit: "Expected integer from 1 to 100" });
    return ApiResponse.success(
      c,
      await listRegistryVersions({
        ...context,
        userId: getSessionUserId(context.session),
        catalogId: requireRouteParam(c, "catalogId"),
        limit,
        cursor: c.req.query("cursor"),
      }),
    );
  });
  app.get("/skills/catalog/:catalogId/versions/:versionId", async (c) => {
    const context = await resolveSkillContext(c);
    return ApiResponse.success(
      c,
      // Through the service, which withholds a community skill's full text
      // from a viewer the catalog detail would withhold it from.
      await contentSkillsService.getRegistryVersionDetail({
        teamId: context.teamId,
        workspaceId: context.workspaceId,
        userId: getSessionUserId(context.session),
        catalogId: requireRouteParam(c, "catalogId"),
        versionId: requireRouteParam(c, "versionId"),
      }),
    );
  });
  app.put("/skills/:workspaceSkillId/version", async (c) => {
    const context = await resolveSkillContext(c);
    const userId = getSessionUserId(context.session);
    await requireSkillWorkspace({
      workspaceId: context.workspaceId,
      userId,
      permission: "skills.manage",
    });
    const body = switchSkillVersionSchema.safeParse(await c.req.json());
    if (!body.success) throw ApiError.validation();
    try {
      return ApiResponse.success(
        c,
        await switchRegistryVersion({
          ...context,
          userId,
          workspaceSkillId: requireRouteParam(c, "workspaceSkillId"),
          skillVersionId: body.data.skillVersionId,
          acknowledgeEscalation: body.data.acknowledgeEscalation,
        }),
      );
    } catch (error) {
      // `toApiError` drops a ContentError's details on purpose (they can carry
      // internals). This one IS the payload: the client shows what escalates
      // and retries with `acknowledgeEscalation`.
      if (isContentError(error) && error.code === "SKILL_VERSION_ESCALATION") {
        throw new ApiError(
          error.statusCode,
          error.code,
          error.message,
          error.details as Record<string, unknown>,
        );
      }
      throw error;
    }
  });
  app.get("/skills/catalog", async (c) => {
    const { teamId, workspaceId, session } = await resolveSkillContext(c);
    const parsed = listSkillsCatalogQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }
    if (parsed.data.cursor && !decodeSkillCatalogCursor(parsed.data.cursor)) {
      throw ApiError.validation({ cursor: "Not a catalog cursor" });
    }
    const result = await contentSkillsService.listCatalog({
      teamId,
      workspaceId,
      userId: getSessionUserId(session),
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
      query: parsed.data.q,
      sort: parsed.data.sort,
      filters: {
        category: parsed.data.category,
        trust: parsed.data.trust,
        capability: parsed.data.capability,
        installed: parsed.data.installed,
      },
    });
    return ApiResponse.success(c, result);
  });

  // Registered before `/skills/catalog/:catalogId`, like `by-slug` below: Hono
  // matches in registration order, and that route would otherwise take
  // `categories` for a catalogId.
  app.get("/skills/catalog/categories", async (c) => {
    const { session } = await resolveSkillContext(c);
    return ApiResponse.success(
      c,
      await contentSkillsService.listCatalogCategories({
        userId: getSessionUserId(session),
      }),
    );
  });

  // Registered before `/skills/catalog/:catalogId`: Hono matches in
  // registration order, and that route would otherwise take `by-slug` for a
  // catalogId.
  app.get("/skills/catalog/by-slug/:slug", async (c) => {
    const { teamId, workspaceId, session } = await resolveSkillContext(c);
    const slug = requireRouteParam(c, "slug").trim();
    if (!slug || slug.length > 200) {
      throw ApiError.validation({ slug: "Expected 1 to 200 characters" });
    }
    const result = await contentSkillsService.getCatalogSkillDetailBySlug({
      teamId,
      workspaceId,
      userId: getSessionUserId(session),
      slug,
    });
    return ApiResponse.success(c, result);
  });

  app.get("/skills/registry/search", async (c) => {
    const { teamId, workspaceId, session } = await resolveSkillContext(c);
    const result = await contentSkillsService.searchRegistry({
      teamId,
      workspaceId,
      userId: getSessionUserId(session),
      query: c.req.query("q") ?? "",
    });
    return ApiResponse.success(c, result);
  });

  app.get("/skills", async (c) => {
    const { teamId, workspaceId } = await resolveSkillContext(c);
    const result = await contentSkillsService.listWorkspaceSkills({
      teamId,
      workspaceId,
    });
    return ApiResponse.success(c, result);
  });

  app.get("/skills/catalog/:catalogId", async (c) => {
    const { teamId, workspaceId, session } = await resolveSkillContext(c);
    const result = await contentSkillsService.getCatalogSkillDetail({
      teamId,
      workspaceId,
      userId: getSessionUserId(session),
      catalogId: decodeURIComponent(requireRouteParam(c, "catalogId")),
    });
    return ApiResponse.success(c, result);
  });

  app.post("/skills", async (c) => {
    const { teamId, workspaceId, session } = await resolveSkillContext(c);
    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = enableWorkspaceSkillRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const { skills } = await contentSkillsService.installSkill({
      teamId,
      workspaceId,
      userId: getSessionUserId(session),
      ref: {
        kind: "version",
        skillId: parsed.data.skillId,
        skillVersionId: parsed.data.skillVersionId,
      },
      configJson: parsed.data.configJson,
    });
    return ApiResponse.success(
      c,
      { workspaceSkill: skills[0]!.workspaceSkill },
      201,
    );
  });

  app.post("/skills/custom", async (c) => {
    const { teamId, workspaceId, session } = await resolveSkillContext(c);
    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = createCustomSkillRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentSkillsService.createWorkspaceCustomSkill({
      teamId,
      workspaceId,
      userId: getSessionUserId(session),
      name: parsed.data.name,
      displayName: parsed.data.displayName,
      description: parsed.data.description,
      version: parsed.data.version,
    });
    return ApiResponse.success(c, result, 201);
  });

  app.post("/skills/custom/:skillId/versions", async (c) => {
    const { teamId, workspaceId, session } = await resolveSkillContext(c);
    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = createCustomSkillVersionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentSkillsService.createWorkspaceCustomSkillVersion(
      {
        teamId,
        workspaceId,
        userId: getSessionUserId(session),
        skillId: requireRouteParam(c, "skillId"),
        version: parsed.data.version,
      },
    );
    return ApiResponse.success(c, result, 201);
  });

  app.patch("/skills/custom/:skillId/versions/:versionId", async (c) => {
    const { teamId, workspaceId } = await resolveSkillContext(c);
    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = updateCustomSkillVersionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentSkillsService.updateWorkspaceCustomSkillVersion(
      {
        teamId,
        workspaceId,
        skillId: requireRouteParam(c, "skillId"),
        skillVersionId: requireRouteParam(c, "versionId"),
        displayName: parsed.data.displayName,
        description: parsed.data.description,
      },
    );
    return ApiResponse.success(c, result);
  });

  app.put(
    "/skills/custom/:skillId/versions/:versionId/files/:path{.+}",
    async (c) => {
      const { teamId, workspaceId } = await resolveSkillContext(c);
      const body = ensureObjectBody(await c.req.json().catch(() => ({})));
      const parsed = putCustomSkillVersionFileRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw ApiError.validation(
          parsed.error.flatten() as Record<string, unknown>,
        );
      }

      const result =
        await contentSkillsService.putWorkspaceCustomSkillVersionFile({
          teamId,
          workspaceId,
          skillId: requireRouteParam(c, "skillId"),
          skillVersionId: requireRouteParam(c, "versionId"),
          path: requireRouteParam(c, "path"),
          contentText: parsed.data.contentText,
          mimeType: parsed.data.mimeType,
        });
      return ApiResponse.success(c, result);
    },
  );

  app.delete(
    "/skills/custom/:skillId/versions/:versionId/files/:path{.+}",
    async (c) => {
      const { teamId, workspaceId } = await resolveSkillContext(c);
      const result =
        await contentSkillsService.deleteWorkspaceCustomSkillVersionFile({
          teamId,
          workspaceId,
          skillId: requireRouteParam(c, "skillId"),
          skillVersionId: requireRouteParam(c, "versionId"),
          path: requireRouteParam(c, "path"),
        });
      return ApiResponse.success(c, result);
    },
  );

  app.post("/skills/custom/:skillId/versions/:versionId/publish", async (c) => {
    const { teamId, workspaceId } = await resolveSkillContext(c);
    const result =
      await contentSkillsService.publishWorkspaceCustomSkillVersion({
        teamId,
        workspaceId,
        skillId: requireRouteParam(c, "skillId"),
        skillVersionId: requireRouteParam(c, "versionId"),
      });
    return ApiResponse.success(c, result);
  });

  app.patch("/skills/:workspaceSkillId", async (c) => {
    const { teamId, workspaceId, session } = await resolveSkillContext(c);
    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = updateWorkspaceSkillRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentSkillsService.updateWorkspaceSkill({
      teamId,
      workspaceId,
      userId: getSessionUserId(session),
      workspaceSkillId: requireRouteParam(c, "workspaceSkillId"),
      enabled: parsed.data.enabled,
      configJson: parsed.data.configJson,
    });
    return ApiResponse.success(c, result);
  });

  app.delete("/skills/:workspaceSkillId", async (c) => {
    const { teamId, workspaceId } = await resolveSkillContext(c);
    const result = await contentSkillsService.deleteWorkspaceSkill({
      teamId,
      workspaceId,
      workspaceSkillId: requireRouteParam(c, "workspaceSkillId"),
    });
    return ApiResponse.success(c, result);
  });
}
