import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_LIMITS,
  assistantFeedItemSchema,
  assistantSchema,
  assistantTicketSchema,
  postAssistantMessageRequestSchema,
  ticketActionRequestSchema,
  ticketOriginSchema,
  updateAssistantRequestSchema,
} from "../src/assistants";
import { threadOriginSchema } from "../src/threads";
import * as contracts from "../src/index";

test("posting a message requires non-blank text within the limit and no extra fields", () => {
  assert.equal(
    postAssistantMessageRequestSchema.safeParse({
      text: "Please check the invoice totals",
      idempotencyKey: "key_1",
    }).success,
    true,
  );
  for (const invalid of [
    { text: "   ", idempotencyKey: "key_1" },
    { text: "", idempotencyKey: "key_1" },
    {
      text: "x".repeat(ASSISTANT_LIMITS.feedMessageMax + 1),
      idempotencyKey: "key_1",
    },
    { text: "ok", idempotencyKey: "" },
    { text: "ok", idempotencyKey: "   " },
    { text: "ok" },
    { idempotencyKey: "key_1" },
    { text: "ok", idempotencyKey: "key_1", extra: true },
  ])
    assert.equal(
      postAssistantMessageRequestSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
});

test("updating an assistant needs the version plus an action or a new steward", () => {
  assert.equal(
    updateAssistantRequestSchema.safeParse({ version: 2, action: "pause" })
      .success,
    true,
  );
  assert.equal(
    updateAssistantRequestSchema.safeParse({
      version: 2,
      stewardUserId: "user_2",
    }).success,
    true,
  );
  for (const invalid of [
    { version: 2 },
    { action: "pause" },
    { version: 2, action: "resign" },
    { version: 2, action: "pause", extra: true },
  ])
    assert.equal(
      updateAssistantRequestSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
});

test("a ticket action request is just the idempotency key", () => {
  assert.equal(
    ticketActionRequestSchema.safeParse({ idempotencyKey: "key_1" }).success,
    true,
  );
  for (const invalid of [
    {},
    { idempotencyKey: "" },
    { idempotencyKey: "key_1", extra: 1 },
  ])
    assert.equal(
      ticketActionRequestSchema.safeParse(invalid).success,
      false,
      JSON.stringify(invalid),
    );
});

test("the thread origin vocabulary accepts the two new assistant origins", () => {
  assert.equal(
    threadOriginSchema.parse("assistant_router"),
    "assistant_router",
  );
  assert.equal(
    threadOriginSchema.parse("assistant_ticket"),
    "assistant_ticket",
  );
  assert.equal(threadOriginSchema.safeParse("assistant").success, false);
});

const assistant = {
  id: "asst_1",
  workspaceId: "ws_1",
  routerThreadId: "thread_router_1",
  stewardUserId: "user_1",
  status: "active",
  statusReason: null,
  version: 1,
  createdAt: "2026-11-22T00:00:00.000Z",
  updatedAt: "2026-11-22T00:00:00.000Z",
};

test("a ticket origin is explicit or inferred and nothing else", () => {
  assert.deepEqual(ticketOriginSchema.options, ["explicit", "inferred"]);
  assert.equal(ticketOriginSchema.safeParse("automatic").success, false);
});

test("an assistant record round-trips and its status vocabulary is closed", () => {
  assert.deepEqual(assistantSchema.parse(assistant), assistant);
  assert.equal(
    assistantSchema.safeParse({
      ...assistant,
      status: "paused",
      statusReason: "steward_left",
    }).success,
    true,
  );
  assert.equal(
    assistantSchema.safeParse({ ...assistant, status: "ended" }).success,
    false,
  );
  assert.equal(
    assistantSchema.safeParse({ ...assistant, statusReason: "quit" }).success,
    false,
  );
});

const ticket = {
  id: "ticket_1",
  assistantId: "asst_1",
  workerThreadId: "thread_worker_1",
  title: "Reconcile November invoices",
  goal: "Match invoices against the bank statement",
  payerUserId: "user_1",
  origin: "explicit",
  stage: "working",
  outcome: null,
  blockedReason: null,
  creditCap: ASSISTANT_LIMITS.ticketCreditCapDefault,
  consecutiveFailures: 0,
  lastReportSummary: null,
  createdAt: "2026-11-22T00:00:00.000Z",
  updatedAt: "2026-11-22T00:00:00.000Z",
  endedAt: null,
};

test("a ticket record round-trips and does not expose router bookkeeping", () => {
  assert.deepEqual(assistantTicketSchema.parse(ticket), ticket);
  assert.equal(
    assistantTicketSchema.safeParse({ ...ticket, origin: "inferred" }).success,
    true,
  );
  assert.equal(
    assistantTicketSchema.safeParse({ ...ticket, origin: "automatic" }).success,
    false,
  );
  assert.equal(
    assistantTicketSchema.safeParse({
      ...ticket,
      stage: "ended",
      outcome: "ready",
    }).success,
    true,
  );
  // The entity schema does not know about router/trigger bookkeeping fields,
  // so parsing strips them rather than exposing them to API clients.
  assert.equal(
    "triggerId" in
      assistantTicketSchema.parse({ ...ticket, triggerId: "trigger_1" }),
    false,
  );
});

const feedItem = {
  id: "feed_1",
  assistantId: "asst_1",
  kind: "member_message",
  authorUserId: "user_1",
  text: "Please check the invoice totals",
  ticketId: null,
  ticketEvent: null,
  replyToItemId: null,
  createdAt: "2026-11-22T00:00:00.000Z",
};

test("a feed item round-trips and allows a null author for router/ticket updates", () => {
  assert.deepEqual(assistantFeedItemSchema.parse(feedItem), feedItem);
  assert.equal(
    assistantFeedItemSchema.safeParse({
      ...feedItem,
      kind: "router_message",
      authorUserId: null,
    }).success,
    true,
  );
  assert.equal(
    assistantFeedItemSchema.safeParse({ ...feedItem, kind: "something_else" })
      .success,
    false,
  );
});

test("a ticket update records what happened: a new ticket or a report status", () => {
  const update = {
    ...feedItem,
    kind: "ticket_update",
    authorUserId: null,
    ticketId: "ticket_1",
  };
  for (const ticketEvent of [
    "created",
    "ready",
    "waiting",
    "blocked",
    "failed",
    "dropped",
  ]) {
    assert.equal(
      assistantFeedItemSchema.safeParse({ ...update, ticketEvent }).success,
      true,
      ticketEvent,
    );
  }
  assert.equal(
    assistantFeedItemSchema.safeParse({ ...update, ticketEvent: "closed" })
      .success,
    false,
  );
});

test("the root entry re-exports the assistant contracts", () => {
  assert.equal(contracts.assistantSchema, assistantSchema);
  assert.equal(
    contracts.postAssistantMessageRequestSchema,
    postAssistantMessageRequestSchema,
  );
});
