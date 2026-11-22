import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import {
  createAssistantFixture,
  type AssistantFixture,
} from "../../test/assistant-fixture";

let f: AssistantFixture;

beforeAll(async () => {
  f = await createAssistantFixture("assistant_svc");
}, 120_000);

beforeEach(() => f.reset());

afterAll(async () => {
  await f?.close();
});

/** The error code a rejected call carries, or null when it went through. */
async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    const { statusCode, code } = error as {
      statusCode?: number;
      code?: string;
    };
    return `${statusCode} ${code}`;
  }
}

/** A team workspace with one owner (container admin) and one plain member. */
async function teamWithOwnerAndMember() {
  const owner = randomUUID();
  const member = randomUUID();
  const { teamId, workspaceId } = await f.workspace(
    [
      [owner, "owner"],
      [member, "member"],
    ],
    { kind: "team" },
  );
  return {
    owner,
    member,
    teamId,
    workspaceId,
    ownerCaller: { workspaceId, userId: owner },
    memberCaller: { workspaceId, userId: member },
  };
}

test("only a container admin may enable the assistant; a plain member is refused", async () => {
  const { memberCaller } = await teamWithOwnerAndMember();
  assert.equal(
    await refusal(() => f.service.enable(memberCaller)),
    "403 ASSISTANT_FORBIDDEN",
  );
  assert.equal(await f.assistantRow(memberCaller.workspaceId), null);
});

test("enabling stands up a Router thread and makes the admin the steward", async () => {
  const { owner, teamId, workspaceId, ownerCaller } =
    await teamWithOwnerAndMember();

  const assistant = await f.service.enable(ownerCaller);

  assert.equal(assistant.workspaceId, workspaceId);
  assert.equal(assistant.stewardUserId, owner);
  assert.equal(assistant.status, "active");
  assert.equal(assistant.statusReason, null);
  assert.equal(assistant.version, 1);

  const thread = await f.schema.db.query.threads.findFirst({
    where: (t, { eq }) => eq(t.id, assistant.routerThreadId),
  });
  assert.ok(thread, "the Router thread was created");
  assert.equal(thread!.origin, "assistant_router");
  assert.equal(thread!.teamId, teamId);
  assert.equal(thread!.workspaceId, workspaceId);
  assert.equal(thread!.createdBy, owner);
  // A team workspace's Router conversation is visible to the whole team.
  assert.equal(thread!.visibility, "workspace");

  assert.deepEqual(
    f.audits.map((entry) => [entry.action, entry.actorUserId, entry.teamId]),
    [["assistant.enabled", owner, teamId]],
  );
});

test("a personal workspace's Router thread defaults to private visibility", async () => {
  const owner = randomUUID();
  const { workspaceId } = await f.workspace([[owner, "owner"]], {
    kind: "personal",
  });
  const assistant = await f.service.enable({ workspaceId, userId: owner });
  const thread = await f.schema.db.query.threads.findFirst({
    where: (t, { eq }) => eq(t.id, assistant.routerThreadId),
  });
  assert.equal(thread!.visibility, "private");
});

test("enabling an already-enabled workspace is refused, even by the same admin", async () => {
  const { ownerCaller, workspaceId } = await teamWithOwnerAndMember();
  await f.service.enable(ownerCaller);

  assert.equal(
    await refusal(() => f.service.enable(ownerCaller)),
    "409 ASSISTANT_ALREADY_ENABLED",
  );
  // Still exactly one assistant row for the workspace.
  const row = await f.assistantRow(workspaceId);
  assert.ok(row);
});

test("get on someone else's workspace is a 404, not a 403", async () => {
  const { workspaceId } = await teamWithOwnerAndMember();
  const outsider = randomUUID();
  await f.user(outsider);

  assert.equal(
    await refusal(() => f.service.get({ workspaceId, userId: outsider })),
    "404 ASSISTANT_NOT_FOUND",
  );
});

test("get returns null for a workspace member before the assistant is enabled", async () => {
  const { memberCaller } = await teamWithOwnerAndMember();
  const { assistant } = await f.service.get(memberCaller);
  assert.equal(assistant, null);
});

test("the same idempotency key posted twice leaves one feed item and one trigger, and wakes the assistant only once", async () => {
  const { ownerCaller, memberCaller, member } = await teamWithOwnerAndMember();
  const assistant = await f.service.enable(ownerCaller);
  const idempotencyKey = randomUUID();

  const first = await f.service.postMessage(memberCaller, {
    text: "Please tidy the backlog",
    idempotencyKey,
  });
  assert.equal(first.created, true);
  assert.equal(first.item.authorUserId, member);
  assert.equal(first.item.kind, "member_message");

  const second = await f.service.postMessage(memberCaller, {
    text: "Please tidy the backlog",
    idempotencyKey,
  });
  assert.equal(second.created, false);
  assert.equal(second.item.id, first.item.id);

  const feedItems = await f.feedItemRows(assistant.id);
  assert.equal(feedItems.length, 1);
  const triggers = await f.triggerRows(assistant.id);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0]!.dedupeKey, first.item.id);
  assert.equal(triggers[0]!.sourceKind, "member_message");
  assert.equal(triggers[0]!.status, "pending_eval");

  assert.deepEqual(f.kicked, [assistant.id]);
});

test("a paused assistant refuses a new member message", async () => {
  const { ownerCaller, memberCaller } = await teamWithOwnerAndMember();
  const assistant = await f.service.enable(ownerCaller);

  await f.service.update(ownerCaller, {
    version: assistant.version,
    action: "pause",
  });

  assert.equal(
    await refusal(() =>
      f.service.postMessage(memberCaller, {
        text: "Anyone there?",
        idempotencyKey: randomUUID(),
      }),
    ),
    "409 ASSISTANT_PAUSED",
  );
});

test("update with a stale version is refused", async () => {
  const { ownerCaller } = await teamWithOwnerAndMember();
  const assistant = await f.service.enable(ownerCaller);

  await f.service.update(ownerCaller, {
    version: assistant.version,
    action: "pause",
  });

  assert.equal(
    await refusal(() =>
      f.service.update(ownerCaller, {
        version: assistant.version, // the version before the pause above
        action: "resume",
      }),
    ),
    "409 ASSISTANT_VERSION_CONFLICT",
  );
});

test("changing the steward requires a container admin and records an audit entry", async () => {
  const { owner, member, teamId, ownerCaller, memberCaller } =
    await teamWithOwnerAndMember();
  const assistant = await f.service.enable(ownerCaller);

  // A plain member may not appoint themselves steward.
  assert.equal(
    await refusal(() =>
      f.service.update(memberCaller, {
        version: assistant.version,
        stewardUserId: member,
      }),
    ),
    "403 ASSISTANT_FORBIDDEN",
  );

  const newSteward = randomUUID();
  await f.user(newSteward);
  await f.addMember(teamId, newSteward, "admin");

  const { assistant: updated } = await f.service.update(ownerCaller, {
    version: assistant.version,
    stewardUserId: newSteward,
  });

  assert.equal(updated.stewardUserId, newSteward);
  assert.equal(updated.version, assistant.version + 1);
  assert.deepEqual(
    f.audits
      .filter((entry) => entry.action === "assistant.steward_changed")
      .map((entry) => [entry.action, entry.actorUserId, entry.targetId]),
    [["assistant.steward_changed", owner, assistant.id]],
  );
});

test("the new steward must still be able to reach the workspace", async () => {
  const { ownerCaller } = await teamWithOwnerAndMember();
  const assistant = await f.service.enable(ownerCaller);
  const outsider = randomUUID();
  await f.user(outsider);

  assert.equal(
    await refusal(() =>
      f.service.update(ownerCaller, {
        version: assistant.version,
        stewardUserId: outsider,
      }),
    ),
    "403 ASSISTANT_FORBIDDEN",
  );
});

test("retrying a ticket routes one decided event to it and clears its failure count", async () => {
  const { ownerCaller, teamId, workspaceId } = await teamWithOwnerAndMember();
  const assistant = await f.service.enable(ownerCaller);
  const ticket = await f.insertTicket({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: ownerCaller.userId,
    consecutiveFailures: 3,
  });

  const { ticket: retried } = await f.service.retryTicket(
    ownerCaller,
    ticket.id,
    { idempotencyKey: randomUUID() },
  );

  assert.equal(retried.consecutiveFailures, 0);

  const triggers = await f.triggerRows(assistant.id);
  const routed = triggers.filter((row) => row.routedTicketId === ticket.id);
  assert.equal(routed.length, 1);
  assert.equal(routed[0]!.status, "decided");
});

test("retrying with the same idempotency key adds no second event", async () => {
  const { ownerCaller, teamId, workspaceId } = await teamWithOwnerAndMember();
  const assistant = await f.service.enable(ownerCaller);
  const ticket = await f.insertTicket({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: ownerCaller.userId,
    consecutiveFailures: 2,
  });
  const idempotencyKey = randomUUID();

  await f.service.retryTicket(ownerCaller, ticket.id, { idempotencyKey });
  await f.service.retryTicket(ownerCaller, ticket.id, { idempotencyKey });

  const triggers = await f.triggerRows(assistant.id);
  const routed = triggers.filter((row) => row.routedTicketId === ticket.id);
  assert.equal(routed.length, 1);
});

test("closing a ticket ends it, and closing again is a no-op", async () => {
  const { ownerCaller, teamId, workspaceId } = await teamWithOwnerAndMember();
  const assistant = await f.service.enable(ownerCaller);
  const ticket = await f.insertTicket({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: ownerCaller.userId,
  });

  const { ticket: closed } = await f.service.closeTicket(ownerCaller, ticket.id, {
    idempotencyKey: randomUUID(),
  });
  assert.equal(closed.stage, "ended");
  assert.ok(closed.endedAt);

  const { ticket: closedAgain } = await f.service.closeTicket(
    ownerCaller,
    ticket.id,
    { idempotencyKey: randomUUID() },
  );
  assert.equal(closedAgain.stage, "ended");
  assert.equal(closedAgain.endedAt, closed.endedAt);
});

test("closing a ticket with a run in flight stops it", async () => {
  const { ownerCaller, teamId, workspaceId } = await teamWithOwnerAndMember();
  const assistant = await f.service.enable(ownerCaller);
  const runId = randomUUID();
  const ticket = await f.insertTicket({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: ownerCaller.userId,
    currentRunId: runId,
  });

  await f.service.closeTicket(ownerCaller, ticket.id, {
    idempotencyKey: randomUUID(),
  });

  assert.equal(f.stopped.length, 1);
  assert.equal(f.stopped[0]!.runId, runId);
  assert.equal(f.stopped[0]!.threadId, ticket.workerThreadId);
});

test("a non-member gets a 404 for a ticket action, not a 403", async () => {
  const { ownerCaller, teamId, workspaceId } = await teamWithOwnerAndMember();
  const assistant = await f.service.enable(ownerCaller);
  const ticket = await f.insertTicket({
    teamId,
    workspaceId,
    assistantId: assistant.id,
    payerUserId: ownerCaller.userId,
  });

  const outsider = randomUUID();
  await f.user(outsider);
  // Not even a member of the workspace: the same "not found" as every other
  // non-member lookup in this module, same as `get`.
  assert.equal(
    await refusal(() =>
      f.service.closeTicket(
        { workspaceId, userId: outsider },
        ticket.id,
        { idempotencyKey: randomUUID() },
      ),
    ),
    "404 ASSISTANT_NOT_FOUND",
  );
});

test("a workspace member gets a 404 for a ticket id that is not theirs", async () => {
  const { ownerCaller, memberCaller } = await teamWithOwnerAndMember();
  await f.service.enable(ownerCaller);

  assert.equal(
    await refusal(() =>
      f.service.closeTicket(memberCaller, randomUUID(), {
        idempotencyKey: randomUUID(),
      }),
    ),
    "404 ASSISTANT_TICKET_NOT_FOUND",
  );
});
