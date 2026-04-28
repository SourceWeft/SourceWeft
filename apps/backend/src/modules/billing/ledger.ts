import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { BillingLedgerEntry } from "@sourceweft/contracts";
import type { LedgerEventType, LedgerUnitType } from "@sourceweft/credits-core";
import type { BillingStore } from "./store-port";
import type { BillingAccountState } from "./types";

export type LedgerWriteInput = {
  eventType: LedgerEventType;
  unitType: LedgerUnitType;
  delta: number;
  balanceAfter: number;
  feature: string;
  actorUserId?: string;
  workspaceId?: string;
  referenceId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
};

export async function appendBillingLedger(input: {
  store: BillingStore;
  client: PoolClient;
  account: BillingAccountState;
  entry: LedgerWriteInput;
}) {
  const entry: BillingLedgerEntry = {
    id: randomUUID(),
    teamId: input.account.teamId,
    workspaceId: input.entry.workspaceId ?? null,
    actorUserId: input.entry.actorUserId ?? null,
    feature: input.entry.feature,
    eventType: input.entry.eventType,
    unitType: input.entry.unitType,
    delta: input.entry.delta,
    balanceAfter: input.entry.balanceAfter,
    referenceId: input.entry.referenceId ?? null,
    idempotencyKey: input.entry.idempotencyKey ?? null,
    metadata: input.entry.metadata ?? {},
    createdAt: new Date().toISOString(),
  };

  await input.store.appendLedger(entry, input.client);
  return entry;
}
