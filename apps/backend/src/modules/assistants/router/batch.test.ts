import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { routerBatchKey, selectNextBatch, type PendingTrigger } from "./batch";

function row(input: {
  payerUserId: string;
  sourceKind: "member_message" | "worker_report";
  minutesAgo: number;
  id?: string;
}): PendingTrigger {
  return {
    id: input.id ?? randomUUID(),
    payerUserId: input.payerUserId,
    sourceKind: input.sourceKind,
    createdAt: new Date(Date.now() - input.minutesAgo * 60_000),
  };
}

test("a group with a member_message is picked ahead of an older worker_report-only group", () => {
  const payerA = "payer-a";
  const payerB = "payer-b";
  const rows: PendingTrigger[] = [
    // A's events are both worker reports, and older than B's.
    row({ payerUserId: payerA, sourceKind: "worker_report", minutesAgo: 30 }),
    row({ payerUserId: payerA, sourceKind: "worker_report", minutesAgo: 20 }),
    // B has one, newer, member message.
    row({ payerUserId: payerB, sourceKind: "member_message", minutesAgo: 5 }),
  ];

  const batch = selectNextBatch(rows);
  assert.ok(batch);
  assert.equal(batch.payerUserId, payerB);
  assert.equal(batch.triggerIds.length, 1);
});

test("without any member_message, the oldest group's events go first", () => {
  const payerA = "payer-a";
  const payerB = "payer-b";
  const rows: PendingTrigger[] = [
    row({ payerUserId: payerB, sourceKind: "worker_report", minutesAgo: 5 }),
    row({ payerUserId: payerA, sourceKind: "worker_report", minutesAgo: 30 }),
  ];

  const batch = selectNextBatch(rows);
  assert.ok(batch);
  assert.equal(batch.payerUserId, payerA);
});

test("one payer with 25 pending events yields a batch of only 20", () => {
  const payer = "payer-a";
  const rows: PendingTrigger[] = Array.from({ length: 25 }, (_, i) =>
    row({ payerUserId: payer, sourceKind: "worker_report", minutesAgo: 25 - i }),
  );

  const batch = selectNextBatch(rows);
  assert.ok(batch);
  assert.equal(batch.payerUserId, payer);
  assert.equal(batch.triggerIds.length, 20);
});

test("different payers' events never end up in the same batch", () => {
  const payerA = "payer-a";
  const payerB = "payer-b";
  const aId = randomUUID();
  const bId = randomUUID();
  const rows: PendingTrigger[] = [
    row({ payerUserId: payerA, sourceKind: "member_message", minutesAgo: 1, id: aId }),
    row({ payerUserId: payerB, sourceKind: "member_message", minutesAgo: 1, id: bId }),
  ];

  const batch = selectNextBatch(rows);
  assert.ok(batch);
  // Exactly one payer's events, never both mixed into one batch.
  assert.ok(
    (batch.triggerIds.includes(aId) && !batch.triggerIds.includes(bId)) ||
      (batch.triggerIds.includes(bId) && !batch.triggerIds.includes(aId)),
  );
});

test("excludePayers skips a whole group, not just trims it", () => {
  const payerA = "payer-a";
  const payerB = "payer-b";
  const rows: PendingTrigger[] = [
    row({ payerUserId: payerA, sourceKind: "member_message", minutesAgo: 1 }),
    row({ payerUserId: payerB, sourceKind: "worker_report", minutesAgo: 10 }),
  ];

  const batch = selectNextBatch(rows, new Set([payerA]));
  assert.ok(batch);
  assert.equal(batch.payerUserId, payerB);
});

test("no pending rows (or every payer excluded) yields null", () => {
  assert.equal(selectNextBatch([]), null);
  const rows: PendingTrigger[] = [
    row({ payerUserId: "payer-a", sourceKind: "member_message", minutesAgo: 1 }),
  ];
  assert.equal(selectNextBatch(rows, new Set(["payer-a"])), null);
});

test("routerBatchKey is deterministic and independent of the ids' order", () => {
  const a = randomUUID();
  const b = randomUUID();
  assert.equal(routerBatchKey([a, b]), routerBatchKey([b, a]));
  assert.notEqual(routerBatchKey([a, b]), routerBatchKey([a, randomUUID()]));
});
