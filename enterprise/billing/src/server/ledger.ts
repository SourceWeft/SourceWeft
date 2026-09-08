import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  BillingLedgerEntry,
  BillingOperationType,
} from "@sourceweft/contracts";
import type { LedgerEventType, LedgerUnitType } from "@sourceweft/credits-core";
import type { BillingStore } from "./store-port";
import type { BillingAccountState } from "./types";

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatLedgerUnit(unitType: LedgerUnitType, value?: number) {
  if (unitType === "seat") {
    return value === 1 || value === -1 ? "seat" : "seats";
  }

  if (unitType === "page") {
    return value === 1 || value === -1 ? "page" : "pages";
  }

  return value === 1 || value === -1 ? "credit" : "credits";
}

export function formatSignedLedgerDelta(
  unitType: LedgerUnitType,
  delta: number,
) {
  const prefix = delta > 0 ? "+" : "";
  return `${prefix}${formatNumber(delta)} ${formatLedgerUnit(unitType, delta)}`;
}

export function createOperationId(
  ...parts: Array<string | number | null | undefined>
) {
  return parts
    .filter(
      (part): part is string | number => part !== null && part !== undefined,
    )
    .map((part) => encodeURIComponent(String(part)))
    .join(":");
}

/**
 * Namespaces a ledger idempotency key / operation id by the owning member.
 * `billing_accounts` rows are per (team, user) and the ledger's uniqueness
 * indexes are per team, so deterministic keys (e.g. `cycle-grant:<cycle>`) would
 * otherwise collide across a team's members. Every stored key is scoped by
 * userId; lookups must scope the same way.
 */
export function scopeMemberLedgerKey(userId: string, key: string) {
  return `${userId}:${key}`;
}

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
  operationId?: string;
  operationType?: BillingOperationType;
  activityVisible?: boolean;
  activityTitle?: string;
  activitySummary?: string;
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
    // Attribute every line to the member whose allocation row it moves, so the
    // team activity feed and per-member balances stay consistent.
    actorUserId: input.entry.actorUserId ?? input.account.userId,
    feature: input.entry.feature,
    eventType: input.entry.eventType,
    unitType: input.entry.unitType,
    delta: input.entry.delta,
    balanceAfter: input.entry.balanceAfter,
    referenceId: input.entry.referenceId ?? null,
    // Scope keys by member so per-member deterministic keys never collide on the
    // team-scoped uniqueness indexes.
    idempotencyKey: input.entry.idempotencyKey
      ? scopeMemberLedgerKey(input.account.userId, input.entry.idempotencyKey)
      : null,
    operationId: input.entry.operationId
      ? scopeMemberLedgerKey(input.account.userId, input.entry.operationId)
      : null,
    operationType: input.entry.operationType ?? null,
    activityVisible:
      input.entry.activityVisible ?? input.entry.eventType === "consume",
    activityTitle: input.entry.activityTitle ?? null,
    activitySummary: input.entry.activitySummary ?? null,
    metadata: input.entry.metadata ?? {},
    createdAt: new Date().toISOString(),
  };

  await input.store.appendLedger(entry, input.client);
  return entry;
}
