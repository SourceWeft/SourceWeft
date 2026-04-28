import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../../shared/database";
import { modelGatewayByokKeyRefs } from "../../../shared/db/schema";
import type { ByokKeyRefRecord } from "../types";

type ByokKeyRefRow = typeof modelGatewayByokKeyRefs.$inferSelect;

function mapByokKeyRef(row: ByokKeyRefRow): ByokKeyRefRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    providerName: row.providerName,
    keyRef: row.keyRef,
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
