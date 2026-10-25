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
    ask: (
      invocationId: string,
      askId: string,
      host: string,
      port = 443,
      extra: Record<string, unknown> = {},
    ) =>
      socket.send(
        JSON.stringify({
          type: "network.ask",
          id: invocationId,
          askId,
          host,
          port,
          ...extra,
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
      deadline: new Date(Date.now() + 600_000),
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
      kind: "host",
      method: null,
      path: null,
      secretInBody: false,
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

test("a standing rule is refused for a host the device can never match; the request stays answerable once", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  for (const host of ["intranet", "8.8.8.8", "2001:db8::1"]) {
    const row = await insertRow(w, invocationId, { host });
    await assert.rejects(
      approvals.respondToNetworkRequest({
        userId: w.h.userId,
        workspaceId: w.workspaceId,
        requestId: row.id,
        decision: "allow_always",
      }),
      { code: "NETWORK_HOST_NOT_ALLOWABLE", statusCode: 400 },
      host,
    );
    const [after] = (await requests(w.h.id)).filter((r) => r.id === row.id);
    assert.equal(after!.status, "pending", host);
    assert.equal(after!.resolvedAt, null, host);
    const once = await approvals.respondToNetworkRequest({
      userId: w.h.userId,
      workspaceId: w.workspaceId,
      requestId: row.id,
      decision: "allow_once",
    });
    assert.equal(once.request.scope, "once");
  }
  assert.deepEqual(await rulesOf(w), []);
  assert.equal(
    (await device.waitFor((f) => f.type === "network.decision")).allow,
    true,
  );
});

test("the allow list in the next command's policy keeps only runtime-valid entries", async () => {
  const w = await world();
  const tenant = {
    teamId: w.teamId,
    workspaceId: w.workspaceId,
    userId: w.h.userId,
  };
  for (const targetId of ["api.example.com", "intranet", "2001:db8::1"])
    await schema.db.insert(schema.agentToolTrustRules).values({
      id: randomUUID(),
      ...tenant,
      domain: "network",
      toolName: "network_access",
      targetType: "host",
      targetId,
      allowedRiskLevels: ["medium"],
      status: "active",
      expiresAt: new Date(Date.now() + 3600_000),
    });
  const policy = await approvals.resolveCommandNetworkPolicy({
    deviceId: w.h.id,
    tenant,
    skills: [],
  });
  assert.deepEqual([...policy.allow].sort(), [
    "[2001:db8::1]",
    "api.example.com",
  ]);
});

test("a pending request lapses with its command: min(window, the command's own deadline)", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const soon = await w.invoke();
  const deadline = new Date(Date.now() + 30_000);
  await schema.db
    .update(schema.localToolInvocations)
    .set({ deadline })
    .where(eq(schema.localToolInvocations.id, soon));
  device.ask(soon, "short", "short.example", 443);
  const [short] = await until(
    () => requests(w.h.id),
    (rows) => rows.length === 1,
  );
  assert.equal(short!.expiresAt.getTime(), deadline.getTime());
  const [card] = (
    await approvals.listPendingNetworkRequests({
      userId: w.h.userId,
      workspaceId: w.workspaceId,
      threadId: w.threadId,
    })
  ).requests;
  assert.equal(new Date(card!.expiresAt).getTime(), deadline.getTime());

  // A long-running command keeps the full window.
  const long = await w.invoke();
  device.ask(long, "long", "long.example", 443);
  const rows = await until(
    () => requests(w.h.id),
    (list) => list.length === 2,
  );
  const longRow = rows.find((r) => r.askId === "long")!;
  assert.equal(
    longRow.expiresAt.getTime() - longRow.createdAt.getTime(),
    120_000,
  );

  // A command already past its deadline gets a deny, not a card.
  const late = await w.invoke();
  await schema.db
    .update(schema.localToolInvocations)
    .set({ deadline: new Date(Date.now() - 1000) })
    .where(eq(schema.localToolInvocations.id, late));
  device.ask(late, "late", "late.example", 443);
  assert.deepEqual(
    await device.waitFor(
      (f) => f.type === "network.decision" && f.askId === "late",
    ),
    {
      type: "network.decision",
      askId: "late",
      allow: false,
      reason: "approval timed out",
    },
  );
  assert.equal((await requests(w.h.id)).length, 2);
});

const WRITE = { kind: "request", method: "POST", path: "/v1/items" } as const;
const trustSnapshot = async (w: World) => JSON.stringify(await rulesOf(w));
const pendingFor = (w: World) =>
  approvals.listPendingNetworkRequests({
    userId: w.h.userId,
    workspaceId: w.workspaceId,
    threadId: w.threadId,
  });

test("a write request to a secret-bound host always goes to the user: no mode, rule or answer shortcuts it", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  // A standing rule for the host exists, as does an open mode: neither applies.
  const row = await insertRow(w, invocationId, { host: "api.example.com" });
  await approvals.respondToNetworkRequest({
    userId: w.h.userId,
    workspaceId: w.workspaceId,
    requestId: row.id,
    decision: "allow_always",
  });
  await device.waitFor((f) => f.type === "network.decision");
  const rulesBefore = await trustSnapshot(w);
  assert.equal(JSON.parse(rulesBefore).length, 1);

  for (const mode of ["ask", "open", "strict"] as const) {
    await schema.db
      .update(schema.localDevices)
      .set({ networkMode: mode })
      .where(eq(schema.localDevices.id, w.h.id));
    device.ask(invocationId, `w-${mode}`, "API.example.com", 443, WRITE);
    await until(
      () => requests(w.h.id),
      (rows) => rows.some((r) => r.askId === `w-${mode}`),
    );
    const parked = (await requests(w.h.id)).find(
      (r) => r.askId === `w-${mode}`,
    )!;
    assert.deepEqual(
      {
        kind: parked.kind,
        method: parked.method,
        path: parked.path,
        host: parked.host,
        status: parked.status,
        suggestedBy: parked.suggestedBy,
      },
      {
        kind: "request",
        method: "POST",
        path: "/v1/items",
        host: "api.example.com",
        status: "pending",
        suggestedBy: null,
      },
      mode,
    );
  }
  assert.equal(
    device.inbox.some((f) => f.type === "network.decision"),
    false,
    "nothing was decided on the user's behalf",
  );
  const listed = (await pendingFor(w)).requests.filter(
    (r) => r.kind === "request",
  );
  assert.equal(listed.length, 3);
  assert.deepEqual(
    { ...listed[0], id: "x", createdAt: "x", expiresAt: "x" },
    {
      id: "x",
      kind: "request",
      method: "POST",
      path: "/v1/items",
      secretInBody: false,
      host: "api.example.com",
      port: 443,
      commandPreview: "curl https://example.com/data",
      suggestedBy: null,
      createdAt: "x",
      expiresAt: "x",
    },
  );
  // A host ask is still listed as a host ask.
  assert.equal(
    (await pendingFor(w)).requests.filter((r) => r.kind === "host").length,
    0,
  );

  // Only "once" and "deny" exist for a write request.
  await assert.rejects(
    approvals.respondToNetworkRequest({
      userId: w.h.userId,
      workspaceId: w.workspaceId,
      requestId: listed[0]!.id,
      decision: "allow_always",
    }),
    { code: "NETWORK_REQUEST_ONCE_ONLY", statusCode: 400 },
  );
  assert.equal(
    (await requests(w.h.id)).find((r) => r.id === listed[0]!.id)!.status,
    "pending",
  );
  const once = await approvals.respondToNetworkRequest({
    userId: w.h.userId,
    workspaceId: w.workspaceId,
    requestId: listed[0]!.id,
    decision: "allow_once",
  });
  assert.deepEqual(once.request.scope, "once");
  assert.equal(once.trustRule, undefined);
  assert.deepEqual(await device.waitFor((f) => f.type === "network.decision"), {
    type: "network.decision",
    askId: "w-ask",
    allow: true,
  });
  const denied = await approvals.respondToNetworkRequest({
    userId: w.h.userId,
    workspaceId: w.workspaceId,
    requestId: listed[1]!.id,
    decision: "deny",
  });
  assert.equal(denied.request.status, "denied");
  assert.deepEqual(await device.waitFor((f) => f.type === "network.decision"), {
    type: "network.decision",
    askId: "w-open",
    allow: false,
    reason: "denied by user",
  });
  // The trust-rule table is untouched by every request answer.
  assert.equal(await trustSnapshot(w), rulesBefore);
});

test("a malformed write-request ask is denied as an invalid request and stores nothing", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  const bad: Array<[string, Record<string, unknown>]> = [
    ["no-method", { kind: "request", path: "/x" }],
    ["lower-method", { kind: "request", method: "post", path: "/x" }],
    ["long-method", { kind: "request", method: "P".repeat(17), path: "/x" }],
    ["no-path", { kind: "request", method: "POST" }],
    ["relative-path", { kind: "request", method: "POST", path: "x" }],
    [
      "absolute-uri",
      { kind: "request", method: "POST", path: "http://a.example/x" },
    ],
    [
      "long-path",
      { kind: "request", method: "POST", path: `/${"x".repeat(200)}` },
    ],
    ["newline", { kind: "request", method: "POST", path: "/a\nb" }],
    ["nul", { kind: "request", method: "POST", path: "/a\u0000b" }],
    ["host-with-method", { method: "POST" }],
    ["host-with-path", { kind: "host", path: "/x" }],
    ["unknown-kind", { kind: "rule", method: "POST", path: "/x" }],
  ];
  for (const [askId, extra] of bad) {
    device.ask(invocationId, askId, "api.example.com", 443, extra);
    assert.deepEqual(
      await device.waitFor(
        (f) => f.type === "network.decision" && f.askId === askId,
      ),
      {
        type: "network.decision",
        askId,
        allow: false,
        reason: "invalid request",
      },
      askId,
    );
  }
  assert.equal((await requests(w.h.id)).length, 0);
  assert.equal(device.isOpen(), true);
});

test("a re-sent write-request ask is the same question; a changed one is not", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  device.ask(invocationId, "dup", "api.example.com", 443, WRITE);
  const [pending] = (
    await until(
      () => pendingFor(w),
      (result) => result.requests.length === 1,
    )
  ).requests;
  device.ask(invocationId, "dup", "api.example.com", 443, WRITE);
  await quiet(500);
  assert.equal(
    device.inbox.some((f) => f.type === "network.decision"),
    false,
    "still waiting for the user",
  );
  assert.equal((await requests(w.h.id)).length, 1);
  await approvals.respondToNetworkRequest({
    userId: w.h.userId,
    workspaceId: w.workspaceId,
    requestId: pending!.id,
    decision: "allow_once",
  });
  await device.waitFor((f) => f.type === "network.decision");
  device.ask(invocationId, "dup", "api.example.com", 443, WRITE);
  assert.equal(
    (await device.waitFor((f) => f.type === "network.decision")).allow,
    true,
  );
  // The same askId for a different request, or as a host question, is denied.
  for (const extra of [
    { ...WRITE, method: "DELETE" },
    { ...WRITE, path: "/v1/other" },
    {},
  ]) {
    device.ask(invocationId, "dup", "api.example.com", 443, extra);
    assert.equal(
      (await device.waitFor((f) => f.type === "network.decision")).allow,
      false,
      JSON.stringify(extra),
    );
  }
  assert.equal((await requests(w.h.id)).length, 1);
});

test("write-request rows share the caps and the stale-card rules of host rows", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const capped = await w.invoke();
  for (let i = 0; i < 20; i++)
    await insertRow(w, capped, {
      askId: `req-${i}`,
      kind: "request",
      method: "POST",
      path: "/x",
      status: "expired",
      resolvedAt: new Date(),
      deliveredAt: new Date(),
    });
  device.ask(capped, "one-too-many", "api.example.com", 443, WRITE);
  assert.deepEqual(
    await device.waitFor(
      (f) => f.type === "network.decision" && f.askId === "one-too-many",
    ),
    {
      type: "network.decision",
      askId: "one-too-many",
      allow: false,
      reason: "too many network requests",
    },
  );
  assert.equal((await requests(w.h.id)).length, 20);

  // Pending write requests count towards the computer's budget too.
  for (let command = 0; command < 5; command++) {
    const id = await w.invoke();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        insertRow(w, id, {
          askId: `p-${command}-${i}`,
          kind: "request",
          method: "PUT",
          path: "/y",
        }),
      ),
    );
  }
  device.ask(await w.invoke(), "device-full", "api.example.com", 443, WRITE);
  assert.equal(
    (
      await device.waitFor(
        (f) => f.type === "network.decision" && f.askId === "device-full",
      )
    ).allow,
    false,
  );

  // Stale cards: finished commands and closed connections take them along.
  const one = (await requests(w.h.id)).find((r) => r.askId === "p-0-0")!;
  await schema.db
    .update(schema.localToolInvocations)
    .set({ status: "succeeded" })
    .where(eq(schema.localToolInvocations.id, one.invocationId));
  const ids = (await pendingFor(w)).requests.map((r) => r.id);
  assert.equal(ids.includes(one.id), false);
  // The list is capped at 50 cards; the finished command's is not among them.
  assert.equal(ids.length, 50);
  device.socket.terminate();
  const rows = await until(
    () => requests(w.h.id),
    (list) => list.every((row) => row.status !== "pending"),
  );
  assert.ok(rows.every((row) => row.status === "expired"));
  assert.deepEqual((await pendingFor(w)).requests, []);
});

test("conflicting answers to a write request settle once and never touch trust rules", async () => {
  const w = await world();
  const invocationId = await w.invoke();
  for (let i = 0; i < 6; i++) {
    const row = await insertRow(w, invocationId, {
      kind: "request",
      method: "POST",
      path: `/r/${i}`,
    });
    const respond = (decision: "allow_once" | "deny") =>
      approvals.respondToNetworkRequest({
        userId: w.h.userId,
        workspaceId: w.workspaceId,
        requestId: row.id,
        decision,
      });
    const [a, d] = await Promise.allSettled([
      respond("allow_once"),
      respond("deny"),
    ]);
    const [final] = (await requests(w.h.id)).filter((r) => r.id === row.id);
    assert.ok(
      (a.status === "fulfilled") !== (d.status === "fulfilled"),
      `round ${i}: exactly one answer wins`,
    );
    assert.equal(
      final!.status,
      a.status === "fulfilled" ? "allowed" : "denied",
    );
    assert.equal(final!.scope, a.status === "fulfilled" ? "once" : null);
    const loser = (a.status === "fulfilled" ? d : a) as PromiseRejectedResult;
    assert.equal(loser.reason.code, "NETWORK_REQUEST_RESOLVED");
  }
  assert.deepEqual(await rulesOf(w), []);

  // Racing the expiry sweep: one writer wins here as well.
  for (let i = 0; i < 6; i++) {
    const expiresAt = new Date(Date.now() + 60_000);
    const row = await insertRow(w, invocationId, {
      kind: "request",
      method: "DELETE",
      path: "/gone",
      expiresAt,
    });
    const [answer] = await Promise.allSettled([
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
    const [final] = (await requests(w.h.id)).filter((r) => r.id === row.id);
    assert.equal(
      final!.status,
      answer.status === "fulfilled" ? "allowed" : "expired",
      `round ${i}`,
    );
  }
  assert.deepEqual(await rulesOf(w), []);
});

test("a viewer cannot allow a write request but may deny it", async () => {
  const w = await world({ role: "viewer" });
  const invocationId = await w.invoke();
  const row = await insertRow(w, invocationId, {
    kind: "request",
    method: "POST",
    path: "/x",
  });
  await assert.rejects(
    approvals.respondToNetworkRequest({
      userId: w.h.userId,
      workspaceId: w.workspaceId,
      requestId: row.id,
      decision: "allow_once",
    }),
    { statusCode: 403 },
  );
  assert.equal(
    (
      await approvals.respondToNetworkRequest({
        userId: w.h.userId,
        workspaceId: w.workspaceId,
        requestId: row.id,
        decision: "deny",
      })
    ).request.status,
    "denied",
  );
});

test("a write request whose body carries a stored secret is flagged on the card, and the flag is part of its identity", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  device.ask(invocationId, "body-1", "api.example.com", 443, {
    ...WRITE,
    secretInBody: true,
  });
  device.ask(invocationId, "plain-1", "api.example.com", 443, WRITE);
  const rows = await until(
    () => requests(w.h.id),
    (list) => list.length === 2,
  );
  assert.equal(rows.find((r) => r.askId === "body-1")!.secretInBody, true);
  assert.equal(rows.find((r) => r.askId === "plain-1")!.secretInBody, false);
  const listed = (await pendingFor(w)).requests;
  assert.deepEqual(listed.map((r) => [r.path, r.secretInBody]).sort(), [
    ["/v1/items", false],
    ["/v1/items", true],
  ]);

  // A re-sent ask only replays when the flag matches.
  device.ask(invocationId, "body-1", "api.example.com", 443, {
    ...WRITE,
    secretInBody: true,
  });
  await quiet(400);
  assert.equal(
    device.inbox.some((f) => f.type === "network.decision"),
    false,
    "same question, still waiting",
  );
  device.ask(invocationId, "body-1", "api.example.com", 443, WRITE);
  assert.equal(
    (await device.waitFor((f) => f.type === "network.decision")).allow,
    false,
  );
  device.ask(invocationId, "plain-1", "api.example.com", 443, {
    ...WRITE,
    secretInBody: true,
  });
  assert.equal(
    (await device.waitFor((f) => f.type === "network.decision")).allow,
    false,
  );
  assert.equal((await requests(w.h.id)).length, 2);

  // Allowing it is still an ordinary one-command answer.
  const flagged = listed.find((r) => r.secretInBody)!;
  assert.equal(
    (
      await approvals.respondToNetworkRequest({
        userId: w.h.userId,
        workspaceId: w.workspaceId,
        requestId: flagged.id,
        decision: "allow_once",
      })
    ).request.status,
    "allowed",
  );
  assert.equal(
    (await device.waitFor((f) => f.type === "network.decision")).allow,
    true,
  );
});

test("the body flag is only valid on a write request", async () => {
  const w = await world();
  const device = await connectDevice(w.h.token);
  const invocationId = await w.invoke();
  for (const [askId, extra] of [
    ["host-flag", { secretInBody: true }],
    ["host-kind-flag", { kind: "host", secretInBody: true }],
  ] as const) {
    device.ask(invocationId, askId, "api.example.com", 443, extra);
    assert.deepEqual(
      await device.waitFor(
        (f) => f.type === "network.decision" && f.askId === askId,
      ),
      {
        type: "network.decision",
        askId,
        allow: false,
        reason: "invalid request",
      },
    );
  }
  assert.equal((await requests(w.h.id)).length, 0);
  assert.equal(device.isOpen(), true);
  // A false flag on a host question is just absent.
  device.ask(invocationId, "host-false", "api.example.com", 443, {
    secretInBody: false,
  });
  await until(
    () => requests(w.h.id),
    (rows) => rows.length === 1,
  );
  assert.equal((await requests(w.h.id))[0]!.secretInBody, false);
});
