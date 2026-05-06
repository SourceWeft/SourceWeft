import type { Hono } from "hono";
import {
  createCustomSkillRequestSchema,
  createCustomSkillVersionRequestSchema,
  putCustomSkillVersionFileRequestSchema,
  enableWorkspaceSkillRequestSchema,
  updateCustomSkillVersionRequestSchema,
  updateWorkspaceSkillRequestSchema,
} from "@sourceweft/contracts";
import { contentService } from "../../../modules/content";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

export function registerSkillRoutes(app: Hono) {
  app.get("/skills/catalog", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.listSkillsCatalog({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
    });
    return ApiResponse.success(c, result);
  });

  app.get("/skills", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.listWorkspaceSkills({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
    });
    return ApiResponse.success(c, result);
  });

  app.get("/skills/catalog/:catalogId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.getSkillCatalogDetail({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      catalogId: decodeURIComponent(requireRouteParam(c, "catalogId")),
    });
    return ApiResponse.success(c, result);
  });

  app.post("/skills", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = enableWorkspaceSkillRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.enableWorkspaceSkill({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      skillId: parsed.data.skillId,
      skillVersionId: parsed.data.skillVersionId,
      configJson: parsed.data.configJson,
    });
    return ApiResponse.success(c, result, 201);
  });

  app.post("/skills/custom", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = createCustomSkillRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.createWorkspaceCustomSkill({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      name: parsed.data.name,
      displayName: parsed.data.displayName,
      description: parsed.data.description,
      version: parsed.data.version,
    });
    return ApiResponse.success(c, result, 201);
  });

  app.post("/skills/custom/:skillId/versions", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = createCustomSkillVersionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.createWorkspaceCustomSkillVersion({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      skillId: requireRouteParam(c, "skillId"),
      version: parsed.data.version,
    });
    return ApiResponse.success(c, result, 201);
  });

  app.patch("/skills/custom/:skillId/versions/:versionId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = updateCustomSkillVersionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.updateWorkspaceCustomSkillVersion({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      skillId: requireRouteParam(c, "skillId"),
      skillVersionId: requireRouteParam(c, "versionId"),
      displayName: parsed.data.displayName,
      description: parsed.data.description,
    });
    return ApiResponse.success(c, result);
  });

  app.put("/skills/custom/:skillId/versions/:versionId/files/:path{.+}", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = putCustomSkillVersionFileRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.putWorkspaceCustomSkillVersionFile({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      skillId: requireRouteParam(c, "skillId"),
      skillVersionId: requireRouteParam(c, "versionId"),
      path: requireRouteParam(c, "path"),
      contentText: parsed.data.contentText,
      mimeType: parsed.data.mimeType,
    });
    return ApiResponse.success(c, result);
  });

  app.delete("/skills/custom/:skillId/versions/:versionId/files/:path{.+}", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.deleteWorkspaceCustomSkillVersionFile({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      skillId: requireRouteParam(c, "skillId"),
      skillVersionId: requireRouteParam(c, "versionId"),
      path: requireRouteParam(c, "path"),
    });
    return ApiResponse.success(c, result);
  });

  app.post("/skills/custom/:skillId/versions/:versionId/publish", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.publishWorkspaceCustomSkillVersion({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      skillId: requireRouteParam(c, "skillId"),
      skillVersionId: requireRouteParam(c, "versionId"),
    });
    return ApiResponse.success(c, result);
  });

  app.patch("/skills/:workspaceSkillId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = updateWorkspaceSkillRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentService.updateWorkspaceSkill({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      workspaceSkillId: requireRouteParam(c, "workspaceSkillId"),
      enabled: parsed.data.enabled,
      configJson: parsed.data.configJson,
    });
    return ApiResponse.success(c, result);
  });

  app.delete("/skills/:workspaceSkillId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentService.deleteWorkspaceSkill({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      workspaceSkillId: requireRouteParam(c, "workspaceSkillId"),
    });
    return ApiResponse.success(c, result);
  });
}
