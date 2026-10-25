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
  role: "workspace_admin" | "editor" | "viewer",
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
    role?: "workspace_admin" | "editor" | "viewer";
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

  // Values the sandboxed program controls (a CONNECT target of any length, a
  // port out of range) are denied; they never cost the device its connection.
  const hostile: Array<[string, string, number]> = [
    ["long-host", `${"a".repeat(300)}.com`, 443],
    ["huge-host", "h".repeat(100_000), 443],
    ["port-zero", "x.example", 0],
    ["port-high", "x.example", 65536],
    ["port-fraction", "x.example", 443.5],
    ["empty-host", "", 443],
  ];
  for (const [askId, host, port] of hostile) {
    device.socket.send(
      JSON.stringify({
        type: "network.ask",
        id: invocationId,
        askId,
        host,
        port,
      }),
    );
    const frame = await device.waitFor(
      (f) => f.type === "network.decision" && f.askId === askId,
    );
    assert.equal(frame.allow, false, askId);
  }
  assert.equal((await requests(w.h.id)).length, 1);
  assert.equal(device.isOpen(), true);

  // A broken envelope is still a protocol error.
  device.socket.send(
    JSON.stringify({
      type: "network.ask",
      id: invocationId,
      askId: "p",
      host: "x.example",
      port: "443",
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

type World = Awaited<ReturnType<typeof world>>;

/** A request row written directly, for states that are awkward to reach by asking. */
async function insertRow(
  w: World,
  invocationId: string,
  overrides: Partial<typeof schema.localNetworkRequests.$inferInsert> = {},
) {
  const [row] = await schema.db
    .insert(schema.localNetworkRequests)
    .values({
      id: randomUUID(),
      invocationId,
      deviceId: w.h.id,
      userId: w.h.userId,
      teamId: w.teamId,
      workspaceId: w.workspaceId,
      threadId: w.threadId,
      askId: randomUUID(),
      host: "direct.example",
      port: 443,
      expiresAt: new Date(Date.now() + 120_000),
      ...overrides,
    })
    .returning();
  return row!;
}

const rulesOf = async (w: World) =>
  (await schema.db.select().from(schema.agentToolTrustRules)).filter(
    (rule) => rule.workspaceId === w.workspaceId,
  );

test("a failure while storing the rule leaves the request pending and answerable", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  const row = await insertRow(w, invocationId, {
    askId: "fail-1",
    host: "fail.example",
  });
  await schema.db.execute(sql`
    create or replace function net_rule_fail() returns trigger language plpgsql as $$
    begin
      if new.target_id = 'fail.example' then raise exception 'rule store unavailable'; end if;
      return new;
    end $$`);
  await schema.db.execute(
    sql`create trigger net_rule_fail_t before insert on agent_tool_trust_rules for each row execute function net_rule_fail()`,
  );
  try {
    await assert.rejects(
      approvals.respondToNetworkRequest({
        userId: w.h.userId,
        workspaceId: w.workspaceId,
        requestId: row.id,
        decision: "allow_always",
      }),
    );
  } finally {
    await schema.db.execute(
      sql`drop trigger net_rule_fail_t on agent_tool_trust_rules`,
    );
  }
  const [after] = await requests(w.h.id);
  assert.equal(after!.status, "pending");
  assert.equal(after!.resolvedAt, null);
  assert.deepEqual(await rulesOf(w), []);
  await quiet(600);
  assert.equal(
    device.inbox.some((f) => f.type === "network.decision"),
    false,
    "nothing was decided",
  );
  // The user can simply try again.
  const retried = await approvals.respondToNetworkRequest({
    userId: w.h.userId,
    workspaceId: w.workspaceId,
    requestId: row.id,
    decision: "allow_always",
  });
  assert.equal(retried.request.scope, "always");
  assert.equal((await rulesOf(w)).length, 1);
  assert.deepEqual(await device.waitFor((f) => f.type === "network.decision"), {
    type: "network.decision",
    askId: "fail-1",
    allow: true,
  });
});

test("one standing rule per host: concurrent and repeated 'always' answers reuse and only lengthen it", async () => {
  const w = await world();
  const invocationId = await w.invoke();
  const [a, b, c] = await Promise.all(
    [443, 8443, 9443].map((port) =>
      insertRow(w, invocationId, { host: "same.example", port }),
    ),
  );
  const answer = (id: string, ttlSeconds?: number) =>
    approvals.respondToNetworkRequest({
      userId: w.h.userId,
      workspaceId: w.workspaceId,
      requestId: id,
      decision: "allow_always",
      ...(ttlSeconds ? { ttlSeconds } : {}),
    });
  // The same card answered twice at once, and a second card for the same host.
  const results = await Promise.all([
    answer(a!.id, 3600),
    answer(a!.id, 3600),
    answer(b!.id, 7200),
  ]);
  const rules = await rulesOf(w);
  assert.equal(rules.length, 1);
  assert.deepEqual(
    new Set(results.map((r) => r.trustRule?.id ?? rules[0]!.id)),
    new Set([rules[0]!.id]),
  );
  const expiry = async () => (await rulesOf(w))[0]!.expiresAt!.getTime();
  const longest = await expiry();
  assert.ok(longest - Date.now() > 7100_000, "the longer TTL won");
  // A shorter later grant never shortens it.
  await answer(c!.id, 60);
  assert.equal((await rulesOf(w)).length, 1);
  assert.equal(await expiry(), longest);
  // An expired rule is revived rather than duplicated.
  await schema.db
    .update(schema.agentToolTrustRules)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(schema.agentToolTrustRules.workspaceId, w.workspaceId));
  const d = await insertRow(w, invocationId, {
    host: "same.example",
    port: 7443,
  });
  await answer(d.id, 600);
  const [revived, ...rest] = await rulesOf(w);
  assert.deepEqual(rest, []);
  assert.ok(revived!.expiresAt!.getTime() > Date.now());
});

test("a card never outlives its command: finished commands and closed connections take their requests with them", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const finished = await w.invoke();
  const alive = await w.invoke();
  await insertRow(w, finished, { host: "finished.example" });
  await insertRow(w, alive, { host: "alive.example" });
  const pendingHosts = async () =>
    (
      await approvals.listPendingNetworkRequests({
        userId: w.h.userId,
        workspaceId: w.workspaceId,
        threadId: w.threadId,
      })
    ).requests.map((request) => request.host);
  assert.deepEqual((await pendingHosts()).sort(), [
    "alive.example",
    "finished.example",
  ]);
  // Immediately, without waiting for the sweep.
  await schema.db
    .update(schema.localToolInvocations)
    .set({ status: "succeeded" })
    .where(eq(schema.localToolInvocations.id, finished));
  assert.deepEqual(await pendingHosts(), ["alive.example"]);

  device.socket.terminate();
  const rows = await until(
    () => requests(w.h.id),
    (list) => list.every((row) => row.status !== "pending"),
  );
  assert.ok(rows.every((row) => row.status === "expired"));
  const lost = rows.find((row) => row.host === "alive.example")!;
  assert.equal(lost.reason, "device disconnected");
  assert.ok(lost.deliveredAt, "a later connection is not sent stale decisions");
  assert.deepEqual(await pendingHosts(), []);
});

test("a command and a computer can only leave so many requests waiting", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const capped = await w.invoke();
  for (let i = 0; i < 20; i++)
    await insertRow(w, capped, {
      askId: `old-${i}`,
      status: "expired",
      resolvedAt: new Date(),
      deliveredAt: new Date(),
    });
  device.ask(capped, "one-too-many", "more.example", 443);
  const frame = await device.waitFor(
    (f) => f.type === "network.decision" && f.askId === "one-too-many",
  );
  assert.deepEqual(frame, {
    type: "network.decision",
    askId: "one-too-many",
    allow: false,
    reason: "too many network requests",
  });
  assert.equal((await requests(w.h.id)).length, 20);

  // 100 pending across five commands fill the computer's budget.
  for (let command = 0; command < 5; command++) {
    const id = await w.invoke();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        insertRow(w, id, { askId: `p-${command}-${i}` }),
      ),
    );
  }
  const fresh = await w.invoke();
  device.ask(fresh, "device-full", "more.example", 443);
  assert.equal(
    (
      await device.waitFor(
        (f) => f.type === "network.decision" && f.askId === "device-full",
      )
    ).allow,
    false,
  );
  assert.equal((await requests(w.h.id)).length, 120);
  // Allow-listed hosts do not need a row, so they are not limited.
  await approvals.respondToNetworkRequest({
    userId: w.h.userId,
    workspaceId: w.workspaceId,
    requestId: (await requests(w.h.id)).find((row) => row.askId === "p-0-0")!
      .id,
    decision: "allow_always",
  });
  device.ask(fresh, "still-allowed", "direct.example", 443);
  assert.equal(
    (
      await device.waitFor(
        (f) => f.type === "network.decision" && f.askId === "still-allowed",
      )
    ).allow,
    true,
  );
});

test("answered and expired requests are pruned after a week, rarely and never while pending", async () => {
  const w = await world();
  const invocationId = await w.invoke();
  const day = 24 * 60 * 60 * 1000;
  const settledAt = (daysAgo: number) => new Date(Date.now() - daysAgo * day);
  const old = (daysAgo: number, status: "allowed" | "expired") =>
    insertRow(w, invocationId, {
      status,
      scope: status === "allowed" ? "once" : null,
      resolvedAt: settledAt(daysAgo),
      deliveredAt: settledAt(daysAgo),
      createdAt: settledAt(daysAgo),
    });
  const stale = await old(8, "allowed");
  await old(8, "expired");
  const recent = await old(1, "allowed");
  const pending = await insertRow(w, invocationId, {
    createdAt: settledAt(9),
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(await approvals.pruneSettledNetworkRequests(new Date()), 2);
  assert.deepEqual(
    (await requests(w.h.id)).map((row) => row.id).sort(),
    [recent.id, pending.id].sort(),
  );
  assert.ok(stale.id);

  // Rate limit: the sweep prunes at most once per few minutes per process.
  approvals.resetNetworkPruneClock();
  const t0 = new Date();
  await old(8, "expired");
  await approvals.deliverNetworkDecisions(w.h.id, () => true, { now: t0 });
  assert.equal((await requests(w.h.id)).length, 2, "first sweep prunes");
  await old(8, "expired");
  await approvals.deliverNetworkDecisions(w.h.id, () => true, {
    now: new Date(t0.getTime() + 60_000),
  });
  assert.equal((await requests(w.h.id)).length, 3, "not again within minutes");
  await approvals.deliverNetworkDecisions(w.h.id, () => true, {
    now: new Date(t0.getTime() + 6 * 60_000),
  });
  assert.equal((await requests(w.h.id)).length, 2, "and again later");
});

test("a switch to strict is honoured for a re-sent ask whose first answer was an allow", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  device.ask(invocationId, "replay", "replay.example", 443);
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
  await approvals.respondToNetworkRequest({
    userId: w.h.userId,
    workspaceId: w.workspaceId,
    requestId: pending!.id,
    decision: "allow_once",
  });
  await device.waitFor((f) => f.type === "network.decision");
  await schema.db
    .update(schema.localDevices)
    .set({ networkMode: "strict" })
    .where(eq(schema.localDevices.id, w.h.id));
  device.ask(invocationId, "replay", "replay.example", 443);
  assert.deepEqual(await device.waitFor((f) => f.type === "network.decision"), {
    type: "network.decision",
    askId: "replay",
    allow: false,
    reason: "host is not on the allow list (strict network mode)",
  });
});

test("an answer and the expiry sweep racing for one request: exactly one writer wins", async () => {
  const w = await world();
  const invocationId = await w.invoke();
  for (let i = 0; i < 10; i++) {
    const expiresAt = new Date(Date.now() + 60_000);
    const row = await insertRow(w, invocationId, { expiresAt });
    const [answer, swept] = await Promise.allSettled([
      approvals.respondToNetworkRequest({
        userId: w.h.userId,
        workspaceId: w.workspaceId,
        requestId: row.id,
        decision: "allow_once",
        now: new Date(expiresAt.getTime() - 1),
      }),
      approvals.deliverNetworkDecisions(w.h.id, () => true, {
        now: new Date(expiresAt.getTime() + 1),
        prune: false,
      }),
    ]);
    assert.equal(swept.status, "fulfilled");
    const [final] = (await requests(w.h.id)).filter((r) => r.id === row.id);
    if (answer.status === "fulfilled") {
      assert.equal(final!.status, "allowed", `round ${i}`);
      assert.equal(final!.scope, "once");
    } else {
      assert.equal(final!.status, "expired", `round ${i}`);
      assert.equal(
        (answer.reason as { code: string }).code,
        "NETWORK_REQUEST_EXPIRED",
      );
    }
    assert.ok(final!.resolvedAt);
  }
});

test("a viewer cannot grant network access, though denying stays possible", async () => {
  const w = await world({ role: "viewer" });
  const invocationId = await w.invoke();
  const row = await insertRow(w, invocationId);
  for (const decision of ["allow_once", "allow_always"] as const)
    await assert.rejects(
      approvals.respondToNetworkRequest({
        userId: w.h.userId,
        workspaceId: w.workspaceId,
        requestId: row.id,
        decision,
      }),
      { statusCode: 403 },
    );
  assert.equal((await requests(w.h.id))[0]!.status, "pending");
  assert.deepEqual(await rulesOf(w), []);
  const denied = await approvals.respondToNetworkRequest({
    userId: w.h.userId,
    workspaceId: w.workspaceId,
    requestId: row.id,
    decision: "deny",
  });
  assert.equal(denied.request.status, "denied");
});
