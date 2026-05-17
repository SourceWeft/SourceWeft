import type { Hono } from "hono";
import {
  addByokModelRequestSchema,
  createByokCredentialRequestSchema,
  resolveByokModelCapabilitiesRequestSchema,
} from "@sourceweft/contracts";
import { contentByokService } from "../../../modules/content/byok";
import { getSessionUserId, requireSession } from "../../middleware/auth-session";
import { ApiError, ApiResponse } from "../../response/api-response";
import { ensureObjectBody, requireRouteParam } from "./helpers";

export function registerByokRoutes(app: Hono) {
  app.get("/model-gateway/byok-credentials", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentByokService.listByokCredentials({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });

  app.post("/model-gateway/byok-credentials", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = createByokCredentialRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentByokService.createByokCredential({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      providerName: parsed.data.providerName,
      credentialAlias: parsed.data.credentialAlias,
      apiKey: parsed.data.apiKey,
      providerKind: parsed.data.providerKind,
      baseUrl: parsed.data.baseUrl,
      defaultHeaders: parsed.data.defaultHeaders,
      metadata: parsed.data.metadata,
    });

    return ApiResponse.success(c, result, 201);
  });

  app.delete("/model-gateway/byok-credentials/:credentialId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentByokService.deleteByokCredential({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      credentialId: requireRouteParam(c, "credentialId"),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/model-gateway/byok-credentials/:credentialId/models", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentByokService.listByokModelCandidates({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      credentialId: requireRouteParam(c, "credentialId"),
    });

    return ApiResponse.success(c, result);
  });

  app.get("/model-gateway/byok-models", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const credentialId = c.req.query("credentialId")?.trim() || undefined;
    const result = await contentByokService.listByokModels({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      credentialId,
    });

    return ApiResponse.success(c, result);
  });

  app.post("/model-gateway/byok-models", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = addByokModelRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentByokService.createByokModel({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      credentialId: parsed.data.credentialId,
      modelName: parsed.data.modelName,
      displayName: parsed.data.displayName,
      modelType: parsed.data.modelType,
      config: parsed.data.config,
    });

    return ApiResponse.success(c, result, 201);
  });

  app.delete("/model-gateway/byok-models/:modelId", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentByokService.deleteByokModel({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      modelId: requireRouteParam(c, "modelId"),
    });

    return ApiResponse.success(c, result);
  });

  app.post("/model-gateway/byok-model-capabilities", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const body = ensureObjectBody(await c.req.json().catch(() => null));
    const parsed = resolveByokModelCapabilitiesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.flatten() as Record<string, unknown>,
      );
    }

    const result = await contentByokService.resolveModelCapabilities({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
      modelName: parsed.data.modelName,
    });

    return ApiResponse.success(c, result);
  });

  app.get("/model-gateway/byok-providers", async (c) => {
    const session = await requireSession(c);
    if (!session) {
      throw ApiError.unauthorized();
    }

    const result = await contentByokService.listByokProviders({
      workspaceId: requireRouteParam(c, "workspaceId"),
      userId: getSessionUserId(session),
    });

    return ApiResponse.success(c, result);
  });
}
