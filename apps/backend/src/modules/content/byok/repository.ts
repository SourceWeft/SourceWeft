import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../../shared/database";
import { modelGatewayByokKeyRefs } from "../../../shared/db/schema";

type ByokKeyRefRow = typeof modelGatewayByokKeyRefs.$inferSelect;

export type ByokKeyRefRecord = {
  id: string;
  teamId: string;
  workspaceId: string;
  userId: string | null;
  providerName: string;
  keyRef: string;
  providerKind: string;
  baseUrl: string | null;
  defaultHeaders: Record<string, string>;
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ByokProviderListItem = {
  providerName: string;
  providerKind: string;
  baseUrl: string | null;
  system: boolean;
  isBYOKOnly?: boolean;
  hasApiKey?: boolean;
  keyRefs?: string[];
  defaultHeaders?: Record<string, string>;
};

function mapByokKeyRef(row: ByokKeyRefRow): ByokKeyRefRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    providerName: row.providerName,
    keyRef: row.keyRef,
    providerKind: row.providerKind,
    baseUrl: row.baseUrl,
    defaultHeaders: row.defaultHeadersJson ?? {},
    isActive: row.isActive,
    metadata: row.metadataJson ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listByokKeyRefRecords(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
}) {
  const rows = await db
    .select()
    .from(modelGatewayByokKeyRefs)
    .where(
      and(
        eq(modelGatewayByokKeyRefs.teamId, input.teamId),
        eq(modelGatewayByokKeyRefs.workspaceId, input.workspaceId),
        eq(modelGatewayByokKeyRefs.isActive, true),
      ),
    )
    .orderBy(desc(modelGatewayByokKeyRefs.updatedAt));

  return rows
    .filter((row) => row.userId === null || row.userId === input.userId)
    .map(mapByokKeyRef);
}

export async function createByokKeyRefRecord(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  providerName: string;
  keyRef: string;
  apiKeyEncrypted: string;
  providerKind?: string;
  baseUrl?: string | null;
  defaultHeaders?: Record<string, string>;
  metadata?: Record<string, unknown>;
}) {
  const [row] = await db
    .insert(modelGatewayByokKeyRefs)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      providerName: input.providerName,
      keyRef: input.keyRef,
      apiKeyEncrypted: input.apiKeyEncrypted,
      providerKind: (input.providerKind ?? "openai-compatible") as ByokKeyRefRow["providerKind"],
      baseUrl: input.baseUrl ?? null,
      defaultHeadersJson: input.defaultHeaders ?? {},
      isActive: true,
      metadataJson: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [
        modelGatewayByokKeyRefs.workspaceId,
        modelGatewayByokKeyRefs.userId,
        modelGatewayByokKeyRefs.providerName,
        modelGatewayByokKeyRefs.keyRef,
      ],
      set: {
        apiKeyEncrypted: input.apiKeyEncrypted,
        providerKind: (input.providerKind ?? "openai-compatible") as ByokKeyRefRow["providerKind"],
        baseUrl: input.baseUrl ?? null,
        defaultHeadersJson: input.defaultHeaders ?? {},
        isActive: true,
        metadataJson: input.metadata ?? {},
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create BYOK key ref");
  }

  return mapByokKeyRef(row);
}

export async function deleteByokKeyRefRecord(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  providerName: string;
  keyRef: string;
}) {
  const [row] = await db
    .update(modelGatewayByokKeyRefs)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(modelGatewayByokKeyRefs.teamId, input.teamId),
        eq(modelGatewayByokKeyRefs.workspaceId, input.workspaceId),
        eq(modelGatewayByokKeyRefs.userId, input.userId),
        eq(modelGatewayByokKeyRefs.providerName, input.providerName),
        eq(modelGatewayByokKeyRefs.keyRef, input.keyRef),
        eq(modelGatewayByokKeyRefs.isActive, true),
      ),
    )
    .returning();

  return row ? mapByokKeyRef(row) : null;
}
