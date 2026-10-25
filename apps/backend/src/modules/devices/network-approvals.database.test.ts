import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let access: typeof import("./access");
let service: typeof import("./service");
let approvals: typeof import("./network-approvals");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
let server: Server;
let dispose: () => void;
let port: number;
const sockets: WebSocket[] = [];
const original = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("net_approvals");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  access = await import("./access");
  service = await import("./service");
  approvals = await import("./network-approvals");
  const { attachLocalDeviceGateway } = await import("./gateway");
  server = createServer();
  dispose = attachLocalDeviceGateway(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as { port: number }).port;
}, 120000);

afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  dispose?.();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (original === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original;
});

type Frame = Record<string, unknown> & { type: string };

/** A fake desktop host: the real gateway, a real WebSocket, a frame inbox. */
async function connectDevice(token: string) {
  const inbox: Frame[] = [];
  const waiters: Array<() => void> = [];
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/v1/local-devices/socket`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  sockets.push(socket);
  let closed: { code: number } | null = null;
  socket.on("message", (bytes) => {
    inbox.push(JSON.parse(String(bytes)) as Frame);
    for (const wake of waiters.splice(0)) wake();
  });
  socket.on("close", (code) => {
    closed = { code };
    for (const wake of waiters.splice(0)) wake();
  });
  await once(socket, "open");
  const waitFor = async (
    predicate: (frame: Frame) => boolean,
    timeoutMs = 6000,
  ): Promise<Frame> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = inbox.findIndex(predicate);
      if (index !== -1) return inbox.splice(index, 1)[0]!;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for a device frame");
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, left);
      });
    }
  };
  await waitFor((frame) => frame.type === "connected");
  return {
    socket,
    inbox,
    waitFor,
    isOpen: () => socket.readyState === WebSocket.OPEN,
    closed: () => closed,
    ask: (invocationId: string, askId: string, host: string, port = 443) =>
      socket.send(
        JSON.stringify({
          type: "network.ask",
          id: invocationId,
          askId,
          host,
          port,
        }),
      ),
  };
}

async function enrol(userId = randomUUID()) {
  const sessionId = randomUUID();
  const { ticket } = await service.createEnrollment(userId, sessionId);
  const device = await service.claimEnrollment(ticket, "Test PC");
  const authTicket = await service.createEnrollment(userId, sessionId);
  const proof = await access.createNativeAccess(
    authTicket.ticket,
    device.token,
    "/Users/test/SourceWeft/task-workspaces",
  );
  const caller = await access.resolveLocalCaller(
    userId,
    sessionId,
    proof.proof,
  );
  return { ...device, userId, sessionId, caller };
}

/** A real organization member with an explicit role in the workspace. */
async function addMember(
  workspaceId: string,
  teamId: string,
  userId: string,
  role: "workspace_admin" | "editor",
) {
  await schema.db.execute(sql`
    insert into "user"(id, name, email, "emailVerified")
    values (${userId}, 'Member', ${`${userId}@example.test`}, true)
    on conflict do nothing`);
  await schema.db.execute(sql`
    insert into organization(id, name, slug, "createdAt")
    values (${teamId}, 'Team', ${teamId}, now())
    on conflict do nothing`);
  await schema.db.execute(sql`
    insert into member(id, "organizationId", "userId", role, "createdAt")
    values (${randomUUID()}, ${teamId}, ${userId}, 'member', now())`);
  await schema.db
    .insert(schema.workspaceMemberships)
    .values({ workspaceId, userId, role, source: "direct" });
}

/** An owner with a running `command.execute` on their device. */
async function world(
  options: {
    role?: "workspace_admin" | "editor";
    payload?: Record<string, unknown>;
    status?: string;
  } = {},
) {
  const h = await enrol();
  const workspaceId = randomUUID(),
    teamId = randomUUID(),
    threadId = randomUUID();
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Network",
    slug: workspaceId,
  });
  await addMember(
    workspaceId,
    teamId,
    h.userId,
    options.role ?? "workspace_admin",
  );
  await schema.db.insert(schema.threads).values({
    id: threadId,
    workspaceId,
    teamId,
    createdBy: h.userId,
    title: "Network",
    executionTargetJson: { kind: "local", deviceId: h.id },
  });
  // The invocation must be created after the device connects: opening a
  // connection settles whatever the previous connection left running.
  const invoke = async (
    extra: {
      payload?: Record<string, unknown>;
      status?: string;
      action?: string;
    } = {},
  ) => {
    const id = randomUUID();
    await schema.db.insert(schema.localToolInvocations).values({
      id,
      deviceId: h.id,
      threadId,
      userId: h.userId,
      accessId: h.caller.nativeAccessId,
      action: extra.action ?? "command.execute",
      payload: {
        command: "curl https://example.com/data",
        ...options.payload,
        ...extra.payload,
      },
      status: extra.status ?? options.status ?? "running",
      deadline: new Date(Date.now() + 120_000),
    });
    return id;
  };
  return { h, workspaceId, teamId, threadId, invoke };
}

const requests = (deviceId: string) =>
  schema.db
    .select()
    .from(schema.localNetworkRequests)
    .where(eq(schema.localNetworkRequests.deviceId, deviceId));

async function until<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 4000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const quiet = (ms = 500) => new Promise((resolve) => setTimeout(resolve, ms));

test("an ask parks as a pending row and the user's answer reaches the device exactly once", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  device.ask(invocationId, "ask-1", "Example.COM", 443);

  const listed = await until(
    () =>
      approvals.listPendingNetworkRequests({
        userId: w.h.userId,
        workspaceId: w.workspaceId,
        threadId: w.threadId,
      }),
    (result) => result.requests.length === 1,
  );
  assert.equal(listed.requests.length, 1);
  assert.deepEqual(
    { ...listed.requests[0], id: "x", createdAt: "x", expiresAt: "x" },
    {
      id: "x",
      host: "example.com",
      port: 443,
      commandPreview: "curl https://example.com/data",
      suggestedBy: null,
      createdAt: "x",
      expiresAt: "x",
    },
  );
  const requestId = listed.requests[0]!.id;
  const ttl =
    new Date(listed.requests[0]!.expiresAt).getTime() -
    new Date(listed.requests[0]!.createdAt).getTime();
  assert.equal(ttl, 120_000);
  await quiet();
  assert.equal(
    device.inbox.some((frame) => frame.type === "network.decision"),
    false,
    "nothing is decided before the user answers",
  );

  const answered = await approvals.respondToNetworkRequest({
    userId: w.h.userId,
    workspaceId: w.workspaceId,
    requestId,
    decision: "allow_once",
  });
  assert.deepEqual(answered, {
    request: { id: requestId, status: "allowed", scope: "once" },
  });
  const frame = await device.waitFor((f) => f.type === "network.decision");
  assert.deepEqual(frame, {
    type: "network.decision",
    askId: "ask-1",
    allow: true,
  });
  const [row] = await until(
    () => requests(w.h.id),
    (rows) => rows[0]?.deliveredAt != null,
  );
  assert.equal(row!.status, "allowed");
  assert.equal(row!.scope, "once");
  assert.ok(row!.deliveredAt);
  assert.ok(row!.resolvedAt);

  // Delivered once by the loop; no repeats.
  await quiet(700);
  assert.equal(
    device.inbox.filter((f) => f.type === "network.decision").length,
    0,
  );
  // The same answer twice is a no-op; a different one is a conflict.
  assert.deepEqual(
    await approvals.respondToNetworkRequest({
      userId: w.h.userId,
      workspaceId: w.workspaceId,
      requestId,
      decision: "allow_once",
    }),
    answered,
  );
  await assert.rejects(
    approvals.respondToNetworkRequest({
      userId: w.h.userId,
      workspaceId: w.workspaceId,
      requestId,
      decision: "deny",
    }),
    { code: "NETWORK_REQUEST_RESOLVED", statusCode: 409 },
  );
  // A re-sent ask is answered from the stored row; no second row appears.
  device.ask(invocationId, "ask-1", "example.com", 443);
  assert.deepEqual(await device.waitFor((f) => f.type === "network.decision"), {
    type: "network.decision",
    askId: "ask-1",
    allow: true,
  });
  assert.equal((await requests(w.h.id)).length, 1);
  // "Allow once" is not remembered.
  device.ask(invocationId, "ask-2", "example.com", 443);
  await until(
    () => requests(w.h.id),
    (rows) => rows.length === 2,
  );
  assert.equal((await requests(w.h.id)).length, 2);
  assert.deepEqual(
    (await schema.db.select().from(schema.agentToolTrustRules)).filter(
      (rule) => rule.workspaceId === w.workspaceId,
    ),
    [],
  );
});

test("a denial reaches the device with a reason", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  device.ask(invocationId, "deny-1", "tracker.example", 80);
  const [pending] = (
    await until(
      () =>
        approvals.listPendingNetworkRequests({
          userId: w.h.userId,
          workspaceId: w.workspaceId,
          threadId: w.threadId,
        }),
      (result) => result.requests.length === 1,
    )
  ).requests;
  const response = await approvals.respondToNetworkRequest({
    userId: w.h.userId,
    workspaceId: w.workspaceId,
    requestId: pending!.id,
    decision: "deny",
  });
  assert.equal(response.request.status, "denied");
  assert.deepEqual(await device.waitFor((f) => f.type === "network.decision"), {
    type: "network.decision",
    askId: "deny-1",
    allow: false,
    reason: "denied by user",
  });
  const [row] = await until(
    () => requests(w.h.id),
    (rows) => rows[0]?.deliveredAt != null,
  );
  assert.equal(row!.status, "denied");
  assert.equal(row!.scope, null);
});

test("allow_always stores a trust rule: the next ask is answered at once and the next command is pre-allowed", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  device.ask(invocationId, "a-1", "api.example.com", 443);
  const [pending] = (
    await until(
      () =>
        approvals.listPendingNetworkRequests({
          userId: w.h.userId,
          workspaceId: w.workspaceId,
          threadId: w.threadId,
        }),
      (result) => result.requests.length === 1,
    )
  ).requests;
  const response = await approvals.respondToNetworkRequest({
    userId: w.h.userId,
    workspaceId: w.workspaceId,
    requestId: pending!.id,
    decision: "allow_always",
    ttlSeconds: 3600,
  });
  assert.equal(response.request.scope, "always");
  assert.ok(response.trustRule);
  assert.deepEqual(
    {
      domain: response.trustRule.domain,
      toolName: response.trustRule.toolName,
      targetType: response.trustRule.targetType,
      targetId: response.trustRule.targetId,
      allowedRiskLevels: response.trustRule.allowedRiskLevels,
      workspaceId: response.trustRule.workspaceId,
      userId: response.trustRule.userId,
      connectorId: response.trustRule.connectorId,
      status: response.trustRule.status,
    },
    {
      domain: "network",
      toolName: "network_access",
      targetType: "host",
      targetId: "api.example.com",
      allowedRiskLevels: ["medium"],
      workspaceId: w.workspaceId,
      userId: w.h.userId,
      connectorId: null,
      status: "active",
    },
  );
  const expiresIn =
    new Date(response.trustRule.expiresAt!).getTime() - Date.now();
  assert.ok(expiresIn > 3500_000 && expiresIn <= 3600_000, String(expiresIn));
  await device.waitFor(
    (f) => f.type === "network.decision" && f.allow === true,
  );

  // Repeating the answer does not mint a second rule.
  await approvals.respondToNetworkRequest({
    userId: w.h.userId,
    workspaceId: w.workspaceId,
    requestId: pending!.id,
    decision: "allow_always",
  });
  const rulesFor = async () =>
    (await schema.db.select().from(schema.agentToolTrustRules)).filter(
      (rule) => rule.workspaceId === w.workspaceId,
    );
  assert.equal((await rulesFor()).length, 1);

  // Another port of the same host: answered immediately, nothing parked.
  device.ask(invocationId, "a-2", "API.example.com", 8443);
  assert.deepEqual(await device.waitFor((f) => f.type === "network.decision"), {
    type: "network.decision",
    askId: "a-2",
    allow: true,
  });
  assert.equal((await requests(w.h.id)).length, 1);
  // The rule does not cover a sibling host.
  device.ask(invocationId, "a-3", "other.example.com", 443);
  await until(
    () => requests(w.h.id),
    (rows) => rows.length === 2,
  );
  assert.equal((await requests(w.h.id)).length, 2);

  // The next command's policy carries it; a revoked rule stops applying.
  const tenant = {
    teamId: w.teamId,
    workspaceId: w.workspaceId,
    userId: w.h.userId,
  };
  assert.deepEqual(
    await approvals.resolveCommandNetworkPolicy({
      deviceId: w.h.id,
      tenant,
      skills: [],
    }),
    { mode: "ask", allow: ["api.example.com"], suggested: {} },
  );
  await schema.db
    .update(schema.agentToolTrustRules)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(schema.agentToolTrustRules.workspaceId, w.workspaceId));
  assert.deepEqual(
    (
      await approvals.resolveCommandNetworkPolicy({
        deviceId: w.h.id,
        tenant,
        skills: [],
      })
    ).allow,
    [],
  );
  device.ask(invocationId, "a-4", "api.example.com", 443);
  await until(
    () => requests(w.h.id),
    (rows) => rows.length === 3,
  );
  assert.equal(
    (await requests(w.h.id)).length,
    3,
    "an expired rule asks again",
  );
});

test("standing approvals need approval rights; a refused 'always' can still be answered 'once'", async () => {
  const w = await world({ role: "editor" });
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  device.ask(invocationId, "e-1", "api.example.com", 443);
  const [pending] = (
    await until(
      () =>
        approvals.listPendingNetworkRequests({
          userId: w.h.userId,
          workspaceId: w.workspaceId,
          threadId: w.threadId,
        }),
      (result) => result.requests.length === 1,
    )
  ).requests;
  await assert.rejects(
    approvals.respondToNetworkRequest({
      userId: w.h.userId,
      workspaceId: w.workspaceId,
      requestId: pending!.id,
      decision: "allow_always",
    }),
    { statusCode: 403 },
  );
  assert.equal((await requests(w.h.id))[0]!.status, "pending");
  const once = await approvals.respondToNetworkRequest({
    userId: w.h.userId,
    workspaceId: w.workspaceId,
    requestId: pending!.id,
    decision: "allow_once",
  });
  assert.equal(once.request.scope, "once");
  assert.equal(
    (await schema.db.select().from(schema.agentToolTrustRules)).filter(
      (rule) => rule.workspaceId === w.workspaceId,
    ).length,
    0,
  );
});

test("an unanswered ask expires into a deny; so does one whose command finished", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  const finished = await w.invoke({ payload: { command: "sleep 1" } });
  device.ask(invocationId, "slow", "slow.example.com", 443);
  device.ask(finished, "gone", "gone.example.com", 443);
  await until(
    () => requests(w.h.id),
    (rows) => rows.length === 2,
  );
  await schema.db
    .update(schema.localNetworkRequests)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(schema.localNetworkRequests.askId, "slow"));
  await schema.db
    .update(schema.localToolInvocations)
    .set({ status: "succeeded" })
    .where(eq(schema.localToolInvocations.id, finished));
  const frames = [
    await device.waitFor((f) => f.type === "network.decision"),
    await device.waitFor((f) => f.type === "network.decision"),
  ].sort((a, b) => String(a.askId).localeCompare(String(b.askId)));
  assert.deepEqual(frames, [
    {
      type: "network.decision",
      askId: "gone",
      allow: false,
      reason: "command finished",
    },
    {
      type: "network.decision",
      askId: "slow",
      allow: false,
      reason: "approval timed out",
    },
  ]);
  const rows = await until(
    () => requests(w.h.id),
    (list) => list.every((row) => row.deliveredAt != null),
  );
  assert.deepEqual(
    rows.map((row) => row.status),
    ["expired", "expired"],
  );
  // Nothing left for the user to answer, and answering late is refused.
  assert.deepEqual(
    (
      await approvals.listPendingNetworkRequests({
        userId: w.h.userId,
        workspaceId: w.workspaceId,
        threadId: w.threadId,
      })
    ).requests,
    [],
  );
  await assert.rejects(
    approvals.respondToNetworkRequest({
      userId: w.h.userId,
      workspaceId: w.workspaceId,
      requestId: rows[0]!.id,
      decision: "allow_once",
    }),
    { code: "NETWORK_REQUEST_EXPIRED", statusCode: 409 },
  );
});

test("only the conversation's owner, in its workspace, on a live computer can see or answer a request", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  device.ask(invocationId, "t-1", "tenant.example", 443);
  const [pending] = (
    await until(
      () =>
        approvals.listPendingNetworkRequests({
          userId: w.h.userId,
          workspaceId: w.workspaceId,
          threadId: w.threadId,
        }),
      (result) => result.requests.length === 1,
    )
  ).requests;
  const stranger = randomUUID();
  await addMember(w.workspaceId, w.teamId, stranger, "workspace_admin");
  assert.deepEqual(
    (
      await approvals.listPendingNetworkRequests({
        userId: stranger,
        workspaceId: w.workspaceId,
        threadId: w.threadId,
      })
    ).requests,
    [],
  );
  for (const decision of ["allow_once", "allow_always", "deny"] as const)
    await assert.rejects(
      approvals.respondToNetworkRequest({
        userId: stranger,
        workspaceId: w.workspaceId,
        requestId: pending!.id,
        decision,
      }),
      { code: "NETWORK_REQUEST_NOT_FOUND", statusCode: 404 },
    );
  // Another workspace and an unknown id look the same.
  for (const [workspaceId, requestId] of [
    [randomUUID(), pending!.id],
    [w.workspaceId, randomUUID()],
  ] as const)
    await assert.rejects(
      approvals.respondToNetworkRequest({
        userId: w.h.userId,
        workspaceId,
        requestId,
        decision: "allow_once",
      }),
      { code: "NETWORK_REQUEST_NOT_FOUND" },
    );
  assert.equal((await requests(w.h.id))[0]!.status, "pending");
  // A revoked computer takes its questions with it.
  await schema.db
    .update(schema.localDevices)
    .set({ revokedAt: new Date() })
    .where(eq(schema.localDevices.id, w.h.id));
  await assert.rejects(
    approvals.respondToNetworkRequest({
      userId: w.h.userId,
      workspaceId: w.workspaceId,
      requestId: pending!.id,
      decision: "allow_once",
    }),
    { code: "NETWORK_REQUEST_NOT_FOUND" },
  );
  assert.deepEqual(
    (
      await approvals.listPendingNetworkRequests({
        userId: w.h.userId,
        workspaceId: w.workspaceId,
        threadId: w.threadId,
      })
    ).requests,
    [],
  );
});

test("a bad ask is denied without storing anything or dropping the connection", async () => {
  const w = await world();
  const other = await world();
  const device = await connectDevice(w.h.token);
  await connectDevice(other.h.token);
  const invocationId = await w.invoke();
  const otherInvocation = await other.invoke();
  const finished = await w.invoke({ status: "succeeded" });
  const fileCall = await w.invoke({ action: "file.read" });
  const cases: Array<[string, string, string]> = [
    ["foreign", otherInvocation, "example.com"],
    ["unknown", randomUUID(), "example.com"],
    ["finished", finished, "example.com"],
    ["not-a-command", fileCall, "example.com"],
    ["bad-host", invocationId, "bad host/../x"],
  ];
  for (const [askId, invocationId, host] of cases) {
    device.ask(invocationId, askId, host);
    const frame = await device.waitFor(
      (f) => f.type === "network.decision" && f.askId === askId,
    );
    assert.equal(frame.allow, false, askId);
    assert.equal(typeof frame.reason, "string");
  }
  assert.equal((await requests(w.h.id)).length, 0);
  assert.equal((await requests(other.h.id)).length, 0);
  assert.equal(device.isOpen(), true);
  device.socket.send(JSON.stringify({ type: "heartbeat" }));
  await device.waitFor((f) => f.type === "heartbeat");

  // The same askId for a different target is not a retry of the first.
  device.ask(invocationId, "reuse", "first.example", 443);
  await until(
    () => requests(w.h.id),
    (rows) => rows.length === 1,
  );
  device.ask(invocationId, "reuse", "second.example", 443);
  const reused = await device.waitFor(
    (f) => f.type === "network.decision" && f.askId === "reuse",
  );
  assert.equal(reused.allow, false);
  assert.equal((await requests(w.h.id)).length, 1);

  // Malformed ask frames are still a protocol error, as for any other frame.
  device.socket.send(
    JSON.stringify({
      type: "network.ask",
      id: invocationId,
      askId: "p",
      host: "x.example",
      port: 0,
    }),
  );
  await until(
    async () => device.closed(),
    (closed) => closed != null,
  );
  assert.equal(device.closed()?.code, 1008);
});

test("the mode on the computer decides at ask time, and skills only ever suggest", async () => {
  const w = await world({
    payload: {
      network: {
        mode: "ask",
        allow: [],
        suggested: { "*.skill.example": "my-skill" },
      },
    },
  });
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  device.ask(invocationId, "s-1", "cdn.skill.example", 443);
  const [pending] = (
    await until(
      () =>
        approvals.listPendingNetworkRequests({
          userId: w.h.userId,
          workspaceId: w.workspaceId,
          threadId: w.threadId,
        }),
      (result) => result.requests.length === 1,
    )
  ).requests;
  assert.equal(pending!.suggestedBy, "my-skill");
  await schema.db
    .update(schema.localDevices)
    .set({ networkMode: "strict" })
    .where(eq(schema.localDevices.id, w.h.id));
  device.ask(invocationId, "s-2", "later.example", 443);
  assert.deepEqual(
    await device.waitFor(
      (f) => f.type === "network.decision" && f.askId === "s-2",
    ),
    {
      type: "network.decision",
      askId: "s-2",
      allow: false,
      reason: "host is not on the allow list (strict network mode)",
    },
  );
  await schema.db
    .update(schema.localDevices)
    .set({ networkMode: "open" })
    .where(eq(schema.localDevices.id, w.h.id));
  device.ask(invocationId, "s-3", "later.example", 443);
  assert.equal(
    (
      await device.waitFor(
        (f) => f.type === "network.decision" && f.askId === "s-3",
      )
    ).allow,
    true,
  );
  assert.equal((await requests(w.h.id)).length, 1);
});

test("a computer's mode is changed only from that computer", async () => {
  const w = await world();
  assert.equal(
    (
      await schema.db.query.localDevices.findFirst({
        where: eq(schema.localDevices.id, w.h.id),
      })
    )?.networkMode,
    "ask",
  );
  assert.deepEqual(
    await approvals.setDeviceNetworkMode({
      userId: w.h.userId,
      deviceId: w.h.id,
      caller: w.h.caller,
      networkMode: "strict",
    }),
    { id: w.h.id, networkMode: "strict" },
  );
  assert.equal(
    (
      await approvals.resolveCommandNetworkPolicy({
        deviceId: w.h.id,
        tenant: {
          teamId: w.teamId,
          workspaceId: w.workspaceId,
          userId: w.h.userId,
        },
      })
    ).mode,
    "strict",
  );
  await access.setRemotePolicy(w.h.userId, w.h.id, w.h.caller, true);
  const remote = { sessionId: randomUUID() };
  await access.connectRemote(w.h.userId, remote.sessionId, w.h.id);
  await assert.rejects(
    approvals.setDeviceNetworkMode({
      userId: w.h.userId,
      deviceId: w.h.id,
      caller: remote,
      networkMode: "open",
    }),
    { code: "LOCAL_SETTINGS_ONLY" },
  );
  await assert.rejects(
    approvals.setDeviceNetworkMode({
      userId: randomUUID(),
      deviceId: w.h.id,
      caller: w.h.caller,
      networkMode: "open",
    }),
    { code: "LOCAL_DEVICE_NOT_FOUND" },
  );
  assert.equal(
    (
      await schema.db.query.localDevices.findFirst({
        where: and(eq(schema.localDevices.id, w.h.id)),
      })
    )?.networkMode,
    "strict",
  );
});

test("a retried command keeps its original policy: only the network block may differ", async () => {
  const w = await world();
  await connectDevice(w.h.token);
  const id = randomUUID();
  const payload = { workspaceId: "ws", command: "make", cwd: "." };
  await schema.db.insert(schema.localToolInvocations).values({
    id,
    deviceId: w.h.id,
    threadId: w.threadId,
    userId: w.h.userId,
    accessId: w.h.caller.nativeAccessId,
    action: "command.execute",
    payload: { ...payload, network: { mode: "ask", allow: [], suggested: {} } },
    status: "succeeded",
    result: { output: "done", exitCode: 0 },
    deadline: new Date(Date.now() + 60_000),
  });
  const retry = (extra: Record<string, unknown>) =>
    service.localCall({
      id,
      deviceId: w.h.id,
      userId: w.h.userId,
      threadId: w.threadId,
      caller: w.h.caller,
      action: "command.execute",
      payload: { ...payload, ...extra },
      timeoutMs: 3000,
    });
  assert.deepEqual(
    await retry({
      network: { mode: "ask", allow: ["new.example"], suggested: {} },
    }),
    { output: "done", exitCode: 0 },
  );
  await assert.rejects(retry({ command: "rm -rf build" }), {
    code: "LOCAL_INVOCATION_CONFLICT",
  });
});
