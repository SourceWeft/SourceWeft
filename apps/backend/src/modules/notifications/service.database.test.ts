import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

const sendTemplate = vi.fn();
vi.mock("../mail", () => ({ mailService: { sendTemplate } }));
vi.mock("../auth/mail-locale", () => ({
  resolveMailLocale: vi.fn(async () => "zh-CN"),
}));

let schema: typeof import("@sourceweft/db");
let service: typeof import("./service");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("notifications");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  service = await import("./service");
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

beforeEach(() => {
  sendTemplate.mockReset();
  sendTemplate.mockResolvedValue({ accepted: true });
});

async function user(email = `u-${randomUUID()}@example.test`) {
  const id = randomUUID();
  await schema.database.query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, true, now(), now())`,
    [id, "Test", email],
  );
  return { id, email };
}

const taskRef = (id = randomUUID()) => ({ kind: "agent_task", id });

test("notify stores an in-app notification that lists as unread", async () => {
  const u = await user();
  const teamId = randomUUID();
  const ref = taskRef();
  const result = await service.notify({
    kind: "task_run_catch_up",
    teamId,
    userId: u.id,
    ref,
    payload: { taskName: "Daily digest" },
  });
  assert.equal(result.merged, false);
  const page = await service.listNotifications({ userId: u.id, teamId });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.kind, "task_run_catch_up");
  assert.equal(page.items[0]!.readAt, null);
  assert.deepEqual(page.items[0]!.payload, { taskName: "Daily digest" });
  assert.equal(await service.unreadCount({ userId: u.id, teamId }), 1);
  // Catch-up is in-app only.
  assert.equal(sendTemplate.mock.calls.length, 0);
});

test("a failure notification emails the user once, without result text", async () => {
  const u = await user("person@example.test");
  const teamId = randomUUID();
  await service.notify({
    kind: "task_run_failed",
    teamId,
    userId: u.id,
    ref: taskRef(),
    payload: { taskName: "Digest", threadId: "t1", secret: "do not mail" },
  });
  assert.equal(sendTemplate.mock.calls.length, 1);
  const call = sendTemplate.mock.calls[0]![0];
  assert.equal(call.to, "person@example.test");
  assert.equal(call.templateId, "notification.task-run-failed");
  assert.equal(call.messageType, "biz.notification");
  assert.equal(call.locale, "zh-CN");
  assert.equal(call.variables.taskName, "Digest");
  assert.ok(call.variables.url);
  assert.ok(!JSON.stringify(call.variables).includes("do not mail"));
  const [row] = (
    await schema.database.query(
      "select emailed_at from notifications where user_id = $1",
      [u.id],
    )
  ).rows;
  assert.ok(row.emailed_at);
});

test("success is in-app only unless the caller asks for email", async () => {
  const u = await user();
  const teamId = randomUUID();
  await service.notify({
    kind: "task_run_succeeded",
    teamId,
    userId: u.id,
    ref: taskRef(),
    payload: { taskName: "Digest" },
  });
  assert.equal(sendTemplate.mock.calls.length, 0);
  await service.notify({
    kind: "task_run_succeeded",
    teamId,
    userId: u.id,
    ref: taskRef(),
    payload: { taskName: "Digest 2" },
    email: true,
  });
  assert.equal(sendTemplate.mock.calls.length, 1);
  await service.notify({
    kind: "task_run_failed",
    teamId,
    userId: u.id,
    ref: taskRef(),
    payload: { taskName: "Digest 3" },
    email: false,
  });
  assert.equal(sendTemplate.mock.calls.length, 1);
});

test("the same event for the same task inside the window merges into one row and one email", async () => {
  const u = await user();
  const teamId = randomUUID();
  const ref = taskRef();
  const now = new Date("2026-03-01T08:00:00Z");
  const first = await service.notify({
    kind: "task_run_failed",
    teamId,
    userId: u.id,
    ref,
    payload: { taskName: "Digest", n: 1 },
    now,
  });
  await service.markRead({ userId: u.id, teamId, id: first.id });
  const second = await service.notify({
    kind: "task_run_failed",
    teamId,
    userId: u.id,
    ref,
    payload: { taskName: "Digest", n: 2 },
    now: new Date(now.getTime() + 3 * 3_600_000),
  });
  assert.equal(second.merged, true);
  assert.equal(second.id, first.id);
  assert.equal(sendTemplate.mock.calls.length, 1);
  const page = await service.listNotifications({ userId: u.id, teamId });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.occurrenceCount, 2);
  assert.deepEqual(page.items[0]!.payload, { taskName: "Digest", n: 2 });
  // A merged occurrence surfaces again.
  assert.equal(page.items[0]!.readAt, null);
});

test("outside the window, or for another task or kind, a new notification is created and emailed", async () => {
  const u = await user();
  const teamId = randomUUID();
  const ref = taskRef();
  const now = new Date("2026-03-01T08:00:00Z");
  await service.notify({
    kind: "task_run_failed",
    teamId,
    userId: u.id,
    ref,
    payload: {},
    now,
  });
  await service.notify({
    kind: "task_run_failed",
    teamId,
    userId: u.id,
    ref,
    payload: {},
    now: new Date(now.getTime() + 25 * 3_600_000),
  });
  await service.notify({
    kind: "task_run_failed",
    teamId,
    userId: u.id,
    ref: taskRef(),
    payload: {},
    now,
  });
  await service.notify({
    kind: "task_blocked_quota",
    teamId,
    userId: u.id,
    ref,
    payload: {},
    now,
  });
  const page = await service.listNotifications({ userId: u.id, teamId });
  assert.equal(page.items.length, 4);
  assert.equal(sendTemplate.mock.calls.length, 4);
});

test("concurrent identical events produce one row and one email", async () => {
  const u = await user();
  const teamId = randomUUID();
  const ref = taskRef();
  await Promise.all(
    Array.from({ length: 5 }, () =>
      service.notify({
        kind: "task_needs_approval",
        teamId,
        userId: u.id,
        ref,
        payload: { taskName: "T" },
      }),
    ),
  );
  const page = await service.listNotifications({ userId: u.id, teamId });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.occurrenceCount, 5);
  assert.equal(sendTemplate.mock.calls.length, 1);
});

test("a failed email does not fail the notification and is retried by the next merged event", async () => {
  const u = await user();
  const teamId = randomUUID();
  const ref = taskRef();
  sendTemplate.mockRejectedValueOnce(new Error("provider down"));
  const first = await service.notify({
    kind: "task_run_failed",
    teamId,
    userId: u.id,
    ref,
    payload: {},
  });
  assert.equal(first.emailed, false);
  assert.equal(await service.unreadCount({ userId: u.id, teamId }), 1);
  const second = await service.notify({
    kind: "task_run_failed",
    teamId,
    userId: u.id,
    ref,
    payload: {},
  });
  assert.equal(second.merged, true);
  assert.equal(second.emailed, true);
  assert.equal(sendTemplate.mock.calls.length, 2);
});

test("a user without a reachable email still gets the in-app notification", async () => {
  const teamId = randomUUID();
  const result = await service.notify({
    kind: "task_run_failed",
    teamId,
    userId: `missing-${randomUUID()}`,
    ref: taskRef(),
    payload: {},
  });
  assert.equal(result.emailed, false);
  assert.equal(sendTemplate.mock.calls.length, 0);
});

test("mark read, mark all read and unread counts are scoped to the user and team", async () => {
  const a = await user();
  const b = await user();
  const teamId = randomUUID();
  const otherTeam = randomUUID();
  const n1 = await service.notify({
    kind: "task_run_catch_up",
    teamId,
    userId: a.id,
    ref: taskRef(),
    payload: {},
  });
  await service.notify({
    kind: "task_run_catch_up",
    teamId,
    userId: a.id,
    ref: taskRef(),
    payload: {},
  });
  await service.notify({
    kind: "task_run_catch_up",
    teamId: otherTeam,
    userId: a.id,
    ref: taskRef(),
    payload: {},
  });
  const forB = await service.notify({
    kind: "task_run_catch_up",
    teamId,
    userId: b.id,
    ref: taskRef(),
    payload: {},
  });
  assert.equal(await service.unreadCount({ userId: a.id, teamId }), 2);

  // Another user cannot mark my notification.
  assert.equal(
    await service.markRead({ userId: b.id, teamId, id: n1.id }),
    false,
  );
  assert.equal(
    await service.markRead({ userId: a.id, teamId, id: n1.id }),
    true,
  );
  assert.equal(await service.unreadCount({ userId: a.id, teamId }), 1);

  assert.equal(await service.markAllRead({ userId: a.id, teamId }), 1);
  assert.equal(await service.unreadCount({ userId: a.id, teamId }), 0);
  // Other team and other user are untouched.
  assert.equal(
    await service.unreadCount({ userId: a.id, teamId: otherTeam }),
    1,
  );
  assert.equal(await service.unreadCount({ userId: b.id, teamId }), 1);
  assert.ok(forB.id);
});

test("listing is newest first and pages by cursor, with an unread filter", async () => {
  const u = await user();
  const teamId = randomUUID();
  const base = new Date("2026-03-01T08:00:00Z").getTime();
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await service.notify({
      kind: "task_run_catch_up",
      teamId,
      userId: u.id,
      ref: taskRef(),
      payload: { i },
      now: new Date(base + i * 60_000),
    });
    ids.push(r.id);
  }
  await service.markRead({ userId: u.id, teamId, id: ids[4]! });
  const first = await service.listNotifications({
    userId: u.id,
    teamId,
    limit: 2,
  });
  assert.deepEqual(
    first.items.map((i) => i.id),
    [ids[4], ids[3]],
  );
  assert.ok(first.nextCursor);
  const second = await service.listNotifications({
    userId: u.id,
    teamId,
    limit: 2,
    cursor: first.nextCursor!,
  });
  assert.deepEqual(
    second.items.map((i) => i.id),
    [ids[2], ids[1]],
  );
  const unread = await service.listNotifications({
    userId: u.id,
    teamId,
    unreadOnly: true,
  });
  assert.equal(unread.items.length, 4);
  assert.ok(unread.items.every((i) => i.readAt === null));
});

test("deleting a user's notification data removes only that user's rows", async () => {
  const a = await user();
  const b = await user();
  const teamId = randomUUID();
  for (const u of [a, a, b]) {
    await service.notify({
      kind: "task_run_catch_up",
      teamId,
      userId: u.id,
      ref: taskRef(),
      payload: {},
    });
  }
  assert.equal(await service.deleteUserNotifications(a.id), 2);
  assert.equal(await service.unreadCount({ userId: a.id, teamId }), 0);
  assert.equal(await service.unreadCount({ userId: b.id, teamId }), 1);
});

test("unknown kinds are rejected", async () => {
  await assert.rejects(
    service.notify({
      kind: "nope" as never,
      teamId: randomUUID(),
      userId: randomUUID(),
      ref: taskRef(),
      payload: {},
    }),
    /Unknown notification kind/,
  );
});
