import type { Hono } from "hono";
import {
  createCustomSkillRequestSchema,
  createCustomSkillVersionRequestSchema,
  putCustomSkillVersionFileRequestSchema,
  enableWorkspaceSkillRequestSchema,
  updateCustomSkillVersionRequestSchema,
  updateWorkspaceSkillRequestSchema,
} from "@sourceweft/contracts";
import { contentSkillsService } from "../../../modules/skills";
import { submitRegistrySkillRequestSchema } from "../../../modules/skills/registry/contracts";
import { RegistrySubmissionError } from "../../../modules/skills/registry/errors";
import { requireSkillWorkspace } from "../../../modules/skills/registry/permissions";
import { submitRegistrySkillFromGitHub } from "../../../modules/skills/registry/submit";
import { requireContentWorkspace } from "../../../modules/workspace";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
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
  return { session, teamId: workspace.organizationId, workspaceId: workspace.id };
}

export function registerSkillRoutes(app: Hono) {
  app.get("/skills/catalog", async (c) => {
    const { teamId, workspaceId, session } = await resolveSkillContext(c);
    const result = await contentSkillsService.listCatalog({
      teamId,
      workspaceId,
      userId: getSessionUserId(session),
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

  // Stage 1 — Submit (docs/architecture/skill-registry-index.md §3 Stage 1).
  // Any content contributor (skills.submit) can index a GitHub skill; the scan +
  // triage gate (Stages 3-4) decides indexed-vs-queued, not this endpoint.
  app.post("/skills/registry/submit", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }
    const userId = getSessionUserId(session);
    await requireSkillWorkspace({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId,
      permission: "skills.submit",
    });

    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = submitRegistrySkillRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    try {
      const result = await submitRegistrySkillFromGitHub({
        repoUrl: parsed.data.repoUrl,
        userId,
      });
      return ApiResponse.success(
        c,
        { status: result.status, slug: result.slug },
        201,
      );
    } catch (error) {
      if (error instanceof RegistrySubmissionError) {
        throw new ApiError(422, error.code, error.message);
      }
      throw error;
    }
  });

  app.get("/skills", async (c) => {
    const { teamId, workspaceId } = await resolveSkillContext(c);
    const result = await contentSkillsService.listWorkspaceSkills({ teamId, workspaceId });
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

    const result = await contentSkillsService.enableSkill({
      teamId,
      workspaceId,
      userId: getSessionUserId(session),
      skillId: parsed.data.skillId,
      skillVersionId: parsed.data.skillVersionId,
      configJson: parsed.data.configJson,
    });
    return ApiResponse.success(c, result, 201);
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

    const result = await contentSkillsService.createWorkspaceCustomSkillVersion({
      teamId,
      workspaceId,
      userId: getSessionUserId(session),
      skillId: requireRouteParam(c, "skillId"),
      version: parsed.data.version,
    });
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

    const result = await contentSkillsService.updateWorkspaceCustomSkillVersion({
      teamId,
      workspaceId,
      skillId: requireRouteParam(c, "skillId"),
      skillVersionId: requireRouteParam(c, "versionId"),
      displayName: parsed.data.displayName,
      description: parsed.data.description,
    });
    return ApiResponse.success(c, result);
  });

  app.put("/skills/custom/:skillId/versions/:versionId/files/:path{.+}", async (c) => {
    const { teamId, workspaceId } = await resolveSkillContext(c);
    const body = ensureObjectBody(await c.req.json().catch(() => ({})));
    const parsed = putCustomSkillVersionFileRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentSkillsService.putWorkspaceCustomSkillVersionFile({
      teamId,
      workspaceId,
      skillId: requireRouteParam(c, "skillId"),
      skillVersionId: requireRouteParam(c, "versionId"),
      path: requireRouteParam(c, "path"),
      contentText: parsed.data.contentText,
      mimeType: parsed.data.mimeType,
    });
    return ApiResponse.success(c, result);
  });

  app.delete("/skills/custom/:skillId/versions/:versionId/files/:path{.+}", async (c) => {
    const { teamId, workspaceId } = await resolveSkillContext(c);
    const result = await contentSkillsService.deleteWorkspaceCustomSkillVersionFile({
      teamId,
      workspaceId,
      skillId: requireRouteParam(c, "skillId"),
      skillVersionId: requireRouteParam(c, "versionId"),
      path: requireRouteParam(c, "path"),
    });
    return ApiResponse.success(c, result);
  });

  app.post("/skills/custom/:skillId/versions/:versionId/publish", async (c) => {
    const { teamId, workspaceId } = await resolveSkillContext(c);
    const result = await contentSkillsService.publishWorkspaceCustomSkillVersion({
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
