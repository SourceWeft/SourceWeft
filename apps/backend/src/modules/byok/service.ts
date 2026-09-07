import { config } from "../../shared/config";
import { sanitizeCustomHeaders } from "../../shared/security/public-endpoint";
import {
  createLlmFetch,
  loadLlmEndpointPolicy,
  validateLlmEndpoint,
} from "../../shared/model-gateway/network";
import {
  decryptTeamSecret,
  encryptTeamSecret,
} from "../../shared/team-secrets";
import { listCustomByokProviders } from "../../shared/model-gateway/byok-provider-resolver";
import { discoverByokModelCandidates } from "../../shared/model-gateway/catalog-discovery";
import { resolveModelCapabilitiesFromLitellm } from "../../shared/model-gateway";
import { loadRoutedGatewayConfig } from "../../shared/model-gateway/runtime";
import { ContentError } from "../content/errors";
import { requireContentWorkspace } from "../workspace/guards";
import {
  type ByokProviderListItem,
  createByokCredentialRecord,
  createByokModelRecord,
  deleteByokCredentialRecord,
  deleteByokModelRecord,
  getByokCredentialWithSecretRecord,
  getByokModelRuntimeRecord,
  listByokCredentialRecords,
  listByokModelRecords,
} from "./repository";

type CapabilitySnapshot = {
  supportsThinking: boolean;
  supportsImageInput?: boolean;
  supportedParameters: string[];
  supportedEfforts: Array<"minimal" | "low" | "medium" | "high" | "xhigh">;
  reasoning: boolean;
  reasoningEffort: boolean;
  includeReasoning: boolean;
  supportSources: string[];
  maxCompletionTokens?: number | null;
  litellmKey?: string;
};

async function resolveCapabilitySnapshot(modelName: string) {
  const capabilities = await resolveModelCapabilitiesFromLitellm(
    modelName,
  ).catch(() => null);

  if (!capabilities) {
    return null;
  }

  const supportedParameters = capabilities.supportedParameters ?? [];

  return {
    supportsThinking:
      supportedParameters.includes("reasoning") ||
      supportedParameters.includes("reasoning_effort") ||
      supportedParameters.includes("include_reasoning"),
    supportsImageInput: capabilities.supportsImageInput === true,
    supportedParameters,
    supportedEfforts: capabilities.supportedEfforts ?? [],
    reasoning: supportedParameters.includes("reasoning"),
    reasoningEffort: supportedParameters.includes("reasoning_effort"),
    includeReasoning: supportedParameters.includes("include_reasoning"),
    supportSources: ["model-catalog"],
    maxCompletionTokens: capabilities.max_completion_tokens ?? null,
  } satisfies CapabilitySnapshot;
}

export class ContentByokService {
  async listByokCredentials(input: { workspaceId: string; userId: string }) {
    const workspace = await requireContentWorkspace(input);

    const items = await listByokCredentialRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
    });

    return { items };
  }

  async createByokCredential(input: {
    workspaceId: string;
    userId: string;
    providerName: string;
    credentialAlias: string;
    apiKey: string;
    providerKind?: string;
    baseUrl?: string | null;
    defaultHeaders?: Record<string, string>;
    metadata?: Record<string, unknown>;
  }) {
    const workspace = await requireContentWorkspace(input);
    const baseUrl = input.baseUrl
      ? await validateByokEndpoint(input.baseUrl)
      : null;
    const defaultHeaders = sanitizeByokHeaders(input.defaultHeaders);

    const item = await createByokCredentialRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      providerName: input.providerName,
      credentialAlias: input.credentialAlias,
      // Team-envelope (v2) since every reader of this row — this module and
      // shared/model-gateway's resolveByokApiKeyRef / resolveCustomByokProvider
      // — decrypts via decryptTeamSecret, which also keeps pre-envelope v1
      // rows readable forever.
      apiKeyEncrypted: await encryptTeamSecret(
        input.apiKey,
        workspace.organizationId,
      ),
      providerKind: input.providerKind,
      baseUrl,
      defaultHeaders,
      metadata: input.metadata,
    });

    return { item };
  }

  async deleteByokCredential(input: {
    workspaceId: string;
    userId: string;
    credentialId: string;
  }) {
    const workspace = await requireContentWorkspace(input);

    const deleted = await deleteByokCredentialRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      credentialId: input.credentialId,
    });

    if (!deleted) {
      throw new ContentError(
        404,
        "BYOK_CREDENTIAL_NOT_FOUND",
        "BYOK credential not found",
      );
    }

    return { deleted: true as const, credentialId: input.credentialId };
  }

  async listByokModelCandidates(input: {
    workspaceId: string;
    userId: string;
    credentialId: string;
  }) {
    const workspace = await requireContentWorkspace(input);
    const credential = await getByokCredentialWithSecretRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      credentialId: input.credentialId,
    });

    if (!credential) {
      throw new ContentError(
        404,
        "BYOK_CREDENTIAL_NOT_FOUND",
        "BYOK credential not found",
      );
    }

    const apiKey =
      (await decryptTeamSecret(
        credential.apiKeyEncrypted,
        workspace.organizationId,
      )) || null;
    if (!apiKey) {
      throw new ContentError(
        400,
        "BYOK_CREDENTIAL_INVALID",
        "BYOK credential could not be decrypted",
      );
    }

    const baseUrl = credential.baseUrl
      ? await validateByokEndpoint(credential.baseUrl)
      : null;
    if (!baseUrl) {
      throw new ContentError(
        400,
        "BYOK_PROVIDER_ENDPOINT_REQUIRED",
        "BYOK model discovery requires a provider base URL",
      );
    }

    try {
      const items = await discoverByokModelCandidates({
        fetch: createLlmFetch(await loadLlmEndpointPolicy()),
        providerKind: credential.providerKind,
        providerName: credential.providerName,
        baseUrl,
        apiKey,
        defaultHeaders: credential.defaultHeaders,
      });
      return { items };
    } catch (error) {
      throw new ContentError(
        502,
        "BYOK_MODEL_DISCOVERY_FAILED",
        error instanceof Error
          ? error.message
          : "Failed to discover BYOK provider models",
      );
    }
  }

  async listByokModels(input: {
    workspaceId: string;
    userId: string;
    credentialId?: string;
  }) {
    const workspace = await requireContentWorkspace(input);

    const items = await listByokModelRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      credentialId: input.credentialId,
    });

    return { items };
  }

  async createByokModel(input: {
    workspaceId: string;
    userId: string;
    credentialId: string;
    modelName: string;
    displayName?: string;
    modelType: "llm" | "image" | "vision";
    config?: Record<string, unknown>;
  }) {
    const workspace = await requireContentWorkspace(input);
    const capabilitySnapshot = await resolveCapabilitySnapshot(input.modelName);
    const item = await createByokModelRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      credentialId: input.credentialId,
      modelName: input.modelName,
      displayName: input.displayName?.trim() || input.modelName,
      modelType: input.modelType,
      capabilities: capabilitySnapshot,
      config: input.config,
    });

    if (!item) {
      throw new ContentError(
        404,
        "BYOK_CREDENTIAL_NOT_FOUND",
        "BYOK credential not found",
      );
    }

    return { item };
  }

  async deleteByokModel(input: {
    workspaceId: string;
    userId: string;
    modelId: string;
  }) {
    const workspace = await requireContentWorkspace(input);

    const deleted = await deleteByokModelRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      modelId: input.modelId,
    });

    if (!deleted) {
      throw new ContentError(
        404,
        "BYOK_MODEL_NOT_FOUND",
        "BYOK model not found",
      );
    }

    return { deleted: true as const, modelId: input.modelId };
  }

  async resolveByokModelExecution(input: {
    workspaceId: string;
    userId: string;
    byokModelId: string;
  }) {
    const workspace = await requireContentWorkspace(input);
    const resolved = await getByokModelRuntimeRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      modelId: input.byokModelId,
    });

    if (!resolved) {
      throw new ContentError(
        404,
        "BYOK_MODEL_NOT_FOUND",
        "BYOK model not found",
      );
    }

    const apiKey =
      (await decryptTeamSecret(
        resolved.credential.apiKeyEncrypted,
        workspace.organizationId,
      )) || null;
    if (!apiKey) {
      throw new ContentError(
        400,
        "BYOK_CREDENTIAL_INVALID",
        "BYOK credential could not be decrypted",
      );
    }
    const baseUrl = resolved.credential.baseUrl
      ? await validateByokEndpoint(resolved.credential.baseUrl)
      : null;
    const defaultHeaders = sanitizeByokHeaders(
      resolved.credential.defaultHeaders,
    );

    return {
      byokModelId: resolved.id,
      credentialId: resolved.credentialId,
      credentialAlias: resolved.credential.credentialAlias,
      providerName: resolved.providerName,
      providerKind: resolved.credential.providerKind,
      baseUrl,
      defaultHeaders,
      apiKey,
      modelName: resolved.modelName,
      displayName: resolved.displayName,
      modelType: resolved.modelType,
      capabilities: resolved.capabilities,
    };
  }

  async listByokProviders(input: { workspaceId: string; userId: string }) {
    const workspace = await requireContentWorkspace(input);

    const [routedConfig, customProviders] = await Promise.all([
      loadRoutedGatewayConfig(),
      listCustomByokProviders({
        workspaceId: workspace.id,
        teamId: workspace.organizationId,
        userId: input.userId,
      }),
    ]);

    const items: ByokProviderListItem[] = [];

    for (const [providerName, provider] of Object.entries(
      routedConfig?.providers ?? {},
    )) {
      items.push({
        providerName,
        providerKind: provider.kind,
        baseUrl: provider.baseUrl,
        system: true,
        ...(provider.isBYOK && !provider.hasGlobalApiKey
          ? { isBYOKOnly: true }
          : {}),
        ...(provider.hasGlobalApiKey ? { hasApiKey: true } : {}),
      });
    }

    for (const provider of customProviders) {
      items.push({
        providerName: provider.providerName,
        providerKind: provider.providerKind,
        baseUrl: provider.baseUrl,
        system: false,
        hasApiKey: provider.credentialAliases.length > 0,
        credentialAliases: provider.credentialAliases,
        defaultHeaders: provider.defaultHeaders,
      });
    }

    return {
      items: items.sort((left, right) =>
        left.providerName.localeCompare(right.providerName),
      ),
    };
  }

  async resolveModelCapabilities(input: {
    workspaceId: string;
    userId: string;
    modelName: string;
  }) {
    await requireContentWorkspace(input);

    return {
      capabilities: await resolveCapabilitySnapshot(input.modelName),
    };
  }
}

async function validateByokEndpoint(input: string) {
  try {
    return await validateLlmEndpoint(input);
  } catch (error) {
    throw new ContentError(
      400,
      "BYOK_PROVIDER_ENDPOINT_NOT_ALLOWED",
      error instanceof Error
        ? error.message
        : "BYOK provider endpoint is not allowed",
    );
  }
}

function sanitizeByokHeaders(input?: Record<string, string>) {
  try {
    return sanitizeCustomHeaders(input);
  } catch (error) {
    throw new ContentError(
      400,
      "BYOK_PROVIDER_HEADER_NOT_ALLOWED",
      error instanceof Error
        ? error.message
        : "BYOK provider header is not allowed",
    );
  }
}

export const contentByokService = new ContentByokService();
