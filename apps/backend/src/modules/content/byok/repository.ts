import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../../shared/database";
import {
  modelGatewayByokCredentials,
  modelGatewayByokModels,
} from "../../../shared/db/schema";

type ByokCredentialRow = typeof modelGatewayByokCredentials.$inferSelect;
type ByokModelRow = typeof modelGatewayByokModels.$inferSelect;

export type ByokCredentialRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  userId: string | null;
  providerName: string;
  providerKind: string;
  baseUrl: string | null;
  credentialAlias: string;
  defaultHeaders: Record<string, string>;
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ByokModelRecord = {
  id: string;
  credentialId: string;
  teamId: string;
  workspaceId: string;
  userId: string | null;
  providerName: string;
  modelName: string;
  displayName: string;
  modelType: "llm" | "image" | "vision";
  capabilities: Record<string, unknown> | null;
  config: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ByokResolvedModelRuntime = ByokModelRecord & {
  credential: ByokCredentialRecord & {
    apiKeyEncrypted: string;
  };
};

export type ByokProviderListItem = {
  providerName: string;
  providerKind: string;
  baseUrl: string | null;
  system: boolean;
  isBYOKOnly?: boolean;
  hasApiKey?: boolean;
  credentialIds?: string[];
  credentialAliases?: string[];
  defaultHeaders?: Record<string, string>;
};

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeHeaders(value: unknown): Record<string, string> {
  const record = normalizeRecord(value);
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function mapByokCredential(row: ByokCredentialRow): ByokCredentialRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    providerName: row.providerName,
    providerKind: row.providerKind,
    baseUrl: row.baseUrl,
    credentialAlias: row.credentialAlias,
    defaultHeaders: normalizeHeaders(row.defaultHeadersJson),
    isActive: row.isActive,
    metadata: normalizeRecord(row.metadataJson),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapByokCredentialWithSecret(
  row: ByokCredentialRow,
): ByokCredentialRecord & { apiKeyEncrypted: string } {
  return {
    ...mapByokCredential(row),
    apiKeyEncrypted: row.apiKeyEncrypted,
  };
}

function mapByokModel(row: ByokModelRow): ByokModelRecord {
  return {
    id: row.id,
    credentialId: row.credentialId,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    providerName: row.providerName,
    modelName: row.modelName,
    displayName: row.displayName,
    modelType: row.modelType,
    capabilities: row.capabilitiesJson
      ? normalizeRecord(row.capabilitiesJson)
      : null,
    config: normalizeRecord(row.configJson),
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listByokCredentialRecords(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
}) {
  const rows = await db
    .select()
    .from(modelGatewayByokCredentials)
    .where(
      and(
        eq(modelGatewayByokCredentials.teamId, input.teamId),
        eq(modelGatewayByokCredentials.workspaceId, input.workspaceId),
        eq(modelGatewayByokCredentials.isActive, true),
      ),
    )
    .orderBy(desc(modelGatewayByokCredentials.updatedAt));

  return rows
    .filter((row) => row.userId === null || row.userId === input.userId)
    .map(mapByokCredential);
}

export async function createByokCredentialRecord(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  providerName: string;
  providerKind?: string;
  baseUrl?: string | null;
  credentialAlias: string;
  apiKeyEncrypted: string;
  defaultHeaders?: Record<string, string>;
  metadata?: Record<string, unknown>;
}) {
  const [row] = await db
    .insert(modelGatewayByokCredentials)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      providerName: input.providerName,
      providerKind: (input.providerKind ??
        "openai-compatible") as ByokCredentialRow["providerKind"],
      baseUrl: input.baseUrl ?? null,
      credentialAlias: input.credentialAlias,
      apiKeyEncrypted: input.apiKeyEncrypted,
      defaultHeadersJson: input.defaultHeaders ?? {},
      isActive: true,
      metadataJson: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [
        modelGatewayByokCredentials.workspaceId,
        modelGatewayByokCredentials.userId,
        modelGatewayByokCredentials.providerName,
        modelGatewayByokCredentials.credentialAlias,
      ],
      set: {
        apiKeyEncrypted: input.apiKeyEncrypted,
        providerKind: (input.providerKind ??
          "openai-compatible") as ByokCredentialRow["providerKind"],
        baseUrl: input.baseUrl ?? null,
        defaultHeadersJson: input.defaultHeaders ?? {},
        isActive: true,
        metadataJson: input.metadata ?? {},
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create BYOK credential");
  }

  return mapByokCredential(row);
}

export async function deleteByokCredentialRecord(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  credentialId: string;
}) {
  const [row] = await db
    .update(modelGatewayByokCredentials)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(modelGatewayByokCredentials.teamId, input.teamId),
        eq(modelGatewayByokCredentials.workspaceId, input.workspaceId),
        eq(modelGatewayByokCredentials.userId, input.userId),
        eq(modelGatewayByokCredentials.id, input.credentialId),
        eq(modelGatewayByokCredentials.isActive, true),
      ),
    )
    .returning();

  if (!row) {
    return null;
  }

  await db
    .update(modelGatewayByokModels)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(modelGatewayByokModels.teamId, input.teamId),
        eq(modelGatewayByokModels.workspaceId, input.workspaceId),
        eq(modelGatewayByokModels.userId, input.userId),
        eq(modelGatewayByokModels.credentialId, input.credentialId),
        eq(modelGatewayByokModels.isActive, true),
      ),
    );

  return mapByokCredential(row);
}

export async function listByokModelRecords(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  credentialId?: string;
}) {
  const conditions = [
    eq(modelGatewayByokModels.teamId, input.teamId),
    eq(modelGatewayByokModels.workspaceId, input.workspaceId),
    eq(modelGatewayByokModels.isActive, true),
  ];
  if (input.credentialId) {
    conditions.push(eq(modelGatewayByokModels.credentialId, input.credentialId));
  }

  const rows = await db
    .select()
    .from(modelGatewayByokModels)
    .where(and(...conditions))
    .orderBy(desc(modelGatewayByokModels.updatedAt));

  return rows
    .filter((row) => row.userId === null || row.userId === input.userId)
    .map(mapByokModel);
}

export async function createByokModelRecord(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  credentialId: string;
  modelName: string;
  displayName: string;
  modelType: "llm" | "image" | "vision";
  capabilities?: Record<string, unknown> | null;
  config?: Record<string, unknown>;
}) {
  const credentialRows = await db
    .select()
    .from(modelGatewayByokCredentials)
    .where(
      and(
        eq(modelGatewayByokCredentials.teamId, input.teamId),
        eq(modelGatewayByokCredentials.workspaceId, input.workspaceId),
        eq(modelGatewayByokCredentials.userId, input.userId),
        eq(modelGatewayByokCredentials.id, input.credentialId),
        eq(modelGatewayByokCredentials.isActive, true),
      ),
    )
    .limit(1);
  const credential = credentialRows[0];
  if (!credential) {
    return null;
  }

  const [row] = await db
    .insert(modelGatewayByokModels)
    .values({
      id: randomUUID(),
      credentialId: credential.id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      providerName: credential.providerName,
      modelName: input.modelName,
      displayName: input.displayName,
      modelType: input.modelType,
      capabilitiesJson: input.capabilities ?? null,
      configJson: input.config ?? {},
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [
        modelGatewayByokModels.workspaceId,
        modelGatewayByokModels.userId,
        modelGatewayByokModels.credentialId,
        modelGatewayByokModels.modelName,
        modelGatewayByokModels.modelType,
      ],
      set: {
        displayName: input.displayName,
        providerName: credential.providerName,
        capabilitiesJson: input.capabilities ?? null,
        configJson: input.config ?? {},
        isActive: true,
        updatedAt: new Date(),
      },
    })
    .returning();

  return row ? mapByokModel(row) : null;
}

export async function deleteByokModelRecord(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  modelId: string;
}) {
  const [row] = await db
    .update(modelGatewayByokModels)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(modelGatewayByokModels.teamId, input.teamId),
        eq(modelGatewayByokModels.workspaceId, input.workspaceId),
        eq(modelGatewayByokModels.userId, input.userId),
        eq(modelGatewayByokModels.id, input.modelId),
        eq(modelGatewayByokModels.isActive, true),
      ),
    )
    .returning();

  return row ? mapByokModel(row) : null;
}

export async function getByokModelRuntimeRecord(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  modelId: string;
}): Promise<ByokResolvedModelRuntime | null> {
  const rows = await db
    .select({
      model: modelGatewayByokModels,
      credential: modelGatewayByokCredentials,
    })
    .from(modelGatewayByokModels)
    .innerJoin(
      modelGatewayByokCredentials,
      eq(modelGatewayByokModels.credentialId, modelGatewayByokCredentials.id),
    )
    .where(
      and(
        eq(modelGatewayByokModels.teamId, input.teamId),
        eq(modelGatewayByokModels.workspaceId, input.workspaceId),
        eq(modelGatewayByokModels.id, input.modelId),
        eq(modelGatewayByokModels.isActive, true),
        eq(modelGatewayByokCredentials.isActive, true),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  if (row.model.userId && row.model.userId !== input.userId) {
    return null;
  }
  if (row.credential.userId && row.credential.userId !== input.userId) {
    return null;
  }

  return {
    ...mapByokModel(row.model),
    credential: mapByokCredentialWithSecret(row.credential),
  };
}
