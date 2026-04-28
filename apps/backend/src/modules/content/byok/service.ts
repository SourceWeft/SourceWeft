import { config } from "../../../shared/config";
import { encryptSecret } from "../../../shared/secrets";
import { ContentError } from "../errors";
import { requireContentWorkspace } from "../content-support";
import {
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
      metadata: input.metadata,
    });

    return { item };
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
