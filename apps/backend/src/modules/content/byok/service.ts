import { config } from "../../../shared/config";
import { encryptSecret } from "../../../shared/secrets";
import {
  listCustomByokProviders,
} from "../../../shared/model-gateway/byok-provider-resolver";
import { loadRoutedGatewayConfig } from "../../../shared/model-gateway/runtime";
import { ContentError } from "../errors";
import { requireContentWorkspace } from "../content-support";
import {
  type ByokProviderListItem,
  createByokKeyRefRecord,
  deleteByokKeyRefRecord,
  listByokKeyRefRecords,
} from "./repository";

export class ContentByokService {
  async listByokKeyRefs(input: { workspaceId: string; userId: string }) {
    const workspace = await requireContentWorkspace(input);

    const items = await listByokKeyRefRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
    });

    return { items };
  }

  async createByokKeyRef(input: {
    workspaceId: string;
    userId: string;
    providerName: string;
    keyRef: string;
    apiKey: string;
    providerKind?: string;
    baseUrl?: string | null;
    defaultHeaders?: Record<string, string>;
    metadata?: Record<string, unknown>;
  }) {
    const workspace = await requireContentWorkspace(input);

    const item = await createByokKeyRefRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      providerName: input.providerName,
      keyRef: input.keyRef,
      apiKeyEncrypted: encryptSecret(
        input.apiKey,
        config.modelGatewayEncryptionSecret,
      ),
      providerKind: input.providerKind,
      baseUrl: input.baseUrl,
      defaultHeaders: input.defaultHeaders,
      metadata: input.metadata,
    });

    return { item };
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
        hasApiKey: provider.keyRefs.length > 0,
        keyRefs: provider.keyRefs,
        defaultHeaders: provider.defaultHeaders,
      });
    }

    return {
      items: items.sort((left, right) =>
        left.providerName.localeCompare(right.providerName),
      ),
    };
  }

  async deleteByokKeyRef(input: {
    workspaceId: string;
    userId: string;
    providerName: string;
    keyRef: string;
  }) {
    const workspace = await requireContentWorkspace(input);

    const deleted = await deleteByokKeyRefRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      providerName: input.providerName,
      keyRef: input.keyRef,
    });

    if (!deleted) {
      throw new ContentError(
        404,
        "BYOK_KEY_REF_NOT_FOUND",
        "BYOK key ref not found",
      );
    }

    return { deleted: true as const, keyRef: input.keyRef };
  }
}

export const contentByokService = new ContentByokService();
