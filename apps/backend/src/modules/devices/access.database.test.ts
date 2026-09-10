import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
let schema: typeof import("@sourceweft/db");
let access: typeof import("./access");
let service: typeof import("./service");
let provider: typeof import("./provider");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const original = process.env.DATABASE_URL;
beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("device_access");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  access = await import("./access");
  service = await import("./service");
  provider = await import("./provider");
}, 120000);
afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (original === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original;
});
async function host() {
  const userId = randomUUID(),
    sessionId = randomUUID();
  const { ticket } = await service.createEnrollment(userId, sessionId);
  const device = await service.claimEnrollment(ticket, "Test Mac");
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
  return { ...device, userId, sessionId, caller, proof };
}
test("native use does not enable remote; pairing cannot expand PC policy", async () => {
  const h = await host();
  assert.equal(
    (await access.requireDeviceAccess(h.userId, h.id, h.caller)).native,
    true,
  );
  const remote = { sessionId: randomUUID() };
  await assert.rejects(access.requireDeviceAccess(h.userId, h.id, remote), {
    code: "REMOTE_ACCESS_DISABLED",
  });
  await assert.rejects(access.connectRemote(h.userId, remote.sessionId, h.id), {
    code: "REMOTE_ACCESS_DISABLED",
  });
  await access.setRemotePolicy(h.userId, h.id, h.caller, true);
  await assert.rejects(access.requireDeviceAccess(h.userId, h.id, remote), {
    code: "LOCAL_CONNECTION_REQUIRED",
  });
  await access.connectRemote(h.userId, remote.sessionId, h.id);
  const grant = await access.requireDeviceAccess(h.userId, h.id, remote);
  assert.equal(grant.native, false);
  await assert.rejects(access.setRemotePolicy(h.userId, h.id, remote, false), {
    code: "LOCAL_SETTINGS_ONLY",
  });
  await access.setRemotePolicy(h.userId, h.id, h.caller, false);
  assert.equal(
    await access.isDeviceAccessActive(grant.id, h.userId, h.id),
    false,
  );
  assert.equal(
    (await access.requireDeviceAccess(h.userId, h.id, h.caller)).native,
    true,
  );
  await access.setRemotePolicy(h.userId, h.id, h.caller, true);
  await assert.rejects(access.requireDeviceAccess(h.userId, h.id, remote), {
    code: "LOCAL_CONNECTION_REQUIRED",
  });
});
test("native proof is bound to account and authenticated session; ticket is single use", async () => {
  const h = await host();
  await assert.rejects(
    access.resolveLocalCaller(h.userId, randomUUID(), h.proof.proof),
    { code: "NATIVE_PROOF_EXPIRED" },
  );
  await assert.rejects(
    access.resolveLocalCaller(randomUUID(), h.sessionId, h.proof.proof),
    { code: "NATIVE_PROOF_EXPIRED" },
  );
  await assert.rejects(
    access.requireDeviceAccess(randomUUID(), h.id, h.caller),
    { code: "LOCAL_DEVICE_NOT_FOUND" },
  );
  const { ticket } = await service.createEnrollment(h.userId, h.sessionId);
  await access.createNativeAccess(ticket, h.token, "/Users/test/tasks");
  await assert.rejects(
    access.createNativeAccess(ticket, h.token, "/Users/test/tasks"),
    { code: "NATIVE_SESSION_MISMATCH" },
  );
  await access.revokeSessionDeviceAccess(h.sessionId);
  await assert.rejects(
    access.resolveLocalCaller(h.userId, h.sessionId, h.proof.proof),
    { code: "NATIVE_PROOF_EXPIRED" },
  );
});
test("creation context cannot cross sessions, change targets, or revive revoked access", async () => {
  const h = await host();
  const remote = { sessionId: randomUUID() };
  await access.setRemotePolicy(h.userId, h.id, h.caller, true);
  await access.connectRemote(h.userId, remote.sessionId, h.id);
  const id = randomUUID();
  const target = { kind: "local" as const, deviceId: h.id };
  await schema.db.insert(schema.localCreationContexts).values({
    id,
    userId: h.userId,
    sessionId: remote.sessionId,
    target,
    expiresAt: new Date(Date.now() + 60000),
  });
  assert.deepEqual(
    await access.resolveCreationContext(h.userId, remote, id),
    target,
  );
  await assert.rejects(
    access.resolveCreationContext(h.userId, { sessionId: randomUUID() }, id),
    { code: "CREATION_CONTEXT_EXPIRED" },
  );
  await assert.rejects(
    access.resolveCreationContext(h.userId, remote, id, { kind: "cloud" }),
    { code: "CREATION_CONTEXT_MISMATCH" },
  );
  await assert.rejects(
    access.resolveCreationContext(h.userId, remote, undefined, target),
    { code: "CREATION_CONTEXT_REQUIRED" },
  );
  await access.setRemotePolicy(h.userId, h.id, h.caller, false);
  await assert.rejects(access.resolveCreationContext(h.userId, remote, id), {
    code: "REMOTE_ACCESS_DISABLED",
  });
});
test("offline local Provider assembly does not dispatch a workspace or use cloud", async () => {
  const h = await host(),
    workspaceId = randomUUID(),
    threadId = randomUUID(),
    teamId = randomUUID();
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Local",
    slug: workspaceId,
  });
  await schema.db.insert(schema.threads).values({
    id: threadId,
    teamId,
    workspaceId,
    createdBy: h.userId,
    title: "Local",
    executionTargetJson: { kind: "local", deviceId: h.id },
  });
  const factory = await provider.localProviderForTurn({
    teamId,
    workspaceId,
    threadId,
    userId: h.userId,
    messageId: randomUUID(),
    runId: randomUUID(),
    localCaller: h.caller,
  });
  assert.ok(factory);
  const runtime = factory.createProvider();
  assert.equal(runtime.id, "local");
  assert.match(
    runtime.pathPolicy.workspaceRoot,
    /^\/Users\/test\/SourceWeft\/task-workspaces\//,
  );
  assert.equal(
    (
      await schema.db
        .select()
        .from(schema.localToolInvocations)
        .where(eq(schema.localToolInvocations.threadId, threadId))
    ).length,
    0,
  );
  await assert.rejects(
    runtime.readTextFile!({
      sandboxPath: `${runtime.pathPolicy.workspaceRoot}/file.txt`,
      providerSandboxId: "unused",
    }),
    { code: "DEVICE_OFFLINE" },
  );
});
test("folder and device bindings remain immutable before the first message", async () => {
  const h = await host(),
    workspaceId = randomUUID(),
    threadId = randomUUID(),
    teamId = randomUUID(),
    folderId = randomUUID();
  await schema.db.insert(schema.localFolderGrants).values({
    id: folderId,
    userId: h.userId,
    deviceId: h.id,
    name: "Project",
    path: "/Users/test/Project",
  });
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Local",
    slug: workspaceId,
  });
  await schema.db.insert(schema.threads).values({
    id: threadId,
    teamId,
    workspaceId,
    createdBy: h.userId,
    title: "Empty",
    executionTargetJson: { kind: "local", deviceId: h.id, folderId },
  });
  const binding = await schema.db.query.localThreadBindings.findFirst({
    where: eq(schema.localThreadBindings.threadId, threadId),
  });
  assert.equal(binding?.workspacePath, "/Users/test/Project");
  assert.equal(binding?.folderId, folderId);
  await assert.rejects(
    schema.db
      .update(schema.threads)
      .set({ executionTargetJson: { kind: "cloud" } })
      .where(eq(schema.threads.id, threadId)),
  );
  await assert.rejects(
    schema.db
      .update(schema.localThreadBindings)
      .set({ folderId: null })
      .where(eq(schema.localThreadBindings.threadId, threadId)),
  );
  await assert.rejects(
    schema.db
      .update(schema.localThreadBindings)
      .set({ workspacePath: "/Users/test/Elsewhere" })
      .where(eq(schema.localThreadBindings.threadId, threadId)),
  );
});

test("only the target PC can revoke a folder, without changing historical bindings", async () => {
  const h = await host(),
    folderId = randomUUID();
  await schema.db.insert(schema.localFolderGrants).values({
    id: folderId,
    userId: h.userId,
    deviceId: h.id,
    name: "Folder",
    path: "/Users/test/Folder",
  });
  await access.setRemotePolicy(h.userId, h.id, h.caller, true);
  const remote = { sessionId: randomUUID() };
  await access.connectRemote(h.userId, remote.sessionId, h.id);
  await assert.rejects(
    access.revokeFolderAccess(h.userId, h.id, folderId, remote),
    { code: "LOCAL_SETTINGS_ONLY" },
  );
  await access.revokeFolderAccess(h.userId, h.id, folderId, h.caller);
  await assert.rejects(
    service.validateThreadExecutionTarget(h.userId, {
      kind: "local",
      deviceId: h.id,
      folderId,
    }),
    { code: "LOCAL_FOLDER_NOT_AUTHORIZED" },
  );
  assert.ok(
    (
      await schema.db.query.localFolderGrants.findFirst({
        where: eq(schema.localFolderGrants.id, folderId),
      })
    )?.revokedAt,
  );
});

test("Web sign-out revokes only its connection; PC sign-out disables remote access", async () => {
  const h = await host();
  await access.setRemotePolicy(h.userId, h.id, h.caller, true);
  const first = { sessionId: randomUUID() },
    second = { sessionId: randomUUID() };
  await access.connectRemote(h.userId, first.sessionId, h.id);
  await access.connectRemote(h.userId, second.sessionId, h.id);
  await access.revokeSessionDeviceAccess(first.sessionId);
  assert.equal(
    (await access.requireDeviceAccess(h.userId, h.id, second)).native,
    false,
  );
  await access.revokeSessionDeviceAccess(h.sessionId);
  await assert.rejects(access.requireDeviceAccess(h.userId, h.id, second), {
    code: "REMOTE_ACCESS_DISABLED",
  });
  assert.equal(
    (
      await schema.db.query.localDevices.findFirst({
        where: eq(schema.localDevices.id, h.id),
      })
    )?.remoteEnabled,
    false,
  );
});

test("local invocations compare JSON wire payloads while rejecting real parameter changes", async () => {
  const h = await host();
  const workspaceId = randomUUID(),
    threadId = randomUUID(),
    teamId = randomUUID();
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Wire payload",
    slug: workspaceId,
  });
  await schema.db.insert(schema.threads).values({
    id: threadId,
    teamId,
    workspaceId,
    createdBy: h.userId,
    title: "Wire payload",
    executionTargetJson: { kind: "local", deviceId: h.id },
  });
  await schema.db
    .update(schema.localDevices)
    .set({ heartbeatAt: new Date() })
    .where(eq(schema.localDevices.id, h.id));
  const id = randomUUID();
  const input = {
    id,
    deviceId: h.id,
    userId: h.userId,
    threadId,
    caller: h.caller,
    action: "workspace.ensure",
    payload: {
      workspaceId: "local-workspace",
      folderId: undefined,
      options: { optional: undefined },
    },
    timeoutMs: 3000,
  };
  const completion = service.localCall(input).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );
  let record: typeof schema.localToolInvocations.$inferSelect | undefined;
  for (let i = 0; i < 50; i++) {
    record = await schema.db.query.localToolInvocations.findFirst({
      where: eq(schema.localToolInvocations.id, id),
    });
    if (record) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(record);
  assert.deepEqual(record.payload, {
    workspaceId: "local-workspace",
    options: {},
  });
  // Simulate the native acknowledgement against a real JSONB invocation row.
  await schema.db
    .update(schema.localToolInvocations)
    .set({ status: "succeeded", result: { id: "local-workspace" } })
    .where(eq(schema.localToolInvocations.id, id));
  const first = await completion;
  assert.equal(first.error, null);
  assert.deepEqual(first.value, { id: "local-workspace" });
  assert.deepEqual(
    await service.localCall({
      ...input,
      payload: { options: {}, workspaceId: "local-workspace" },
    }),
    { id: "local-workspace" },
  );
  await assert.rejects(
    service.localCall({
      ...input,
      payload: { workspaceId: "different-workspace" },
    }),
    { code: "LOCAL_INVOCATION_CONFLICT" },
  );
  await assert.rejects(
    service.localCall({ ...input, action: "command.execute" }),
    { code: "LOCAL_INVOCATION_CONFLICT" },
  );
});

test("legacy directory selection remains immutable and cannot bypass registered folder revocation", async () => {
  const h = await host();
  const workspaceId = randomUUID(),
    teamId = randomUUID(),
    threadId = randomUUID(),
    folderId = randomUUID();
  await schema.db
    .insert(schema.workspaces)
    .values({
      id: workspaceId,
      organizationId: teamId,
      name: "Legacy directory",
      slug: workspaceId,
    });
  await schema.db
    .insert(schema.localFolderGrants)
    .values({
      id: folderId,
      deviceId: h.id,
      userId: h.userId,
      name: "Selected folder",
      path: "/Users/test/selected",
    });
  const target = {
    kind: "local" as const,
    deviceId: h.id,
    directoryGrantId: folderId,
  };
  await schema.db
    .insert(schema.threads)
    .values({
      id: threadId,
      teamId,
      workspaceId,
      createdBy: h.userId,
      title: "Legacy directory",
      executionTargetJson: target,
    });
  const binding = await schema.db.query.localThreadBindings.findFirst({
    where: eq(schema.localThreadBindings.threadId, threadId),
  });
  assert.equal(
    binding?.workspacePath,
    null,
    "Legacy grants must be resolved by the native host, never reserved as a default directory",
  );
  assert.equal(binding?.localWorkspaceId, null);
  const contextId = randomUUID();
  await schema.db
    .insert(schema.localCreationContexts)
    .values({
      id: contextId,
      userId: h.userId,
      sessionId: h.sessionId,
      target,
      expiresAt: new Date(Date.now() + 60000),
    });
  await assert.rejects(
    access.resolveCreationContext(h.userId, h.caller, contextId, {
      ...target,
      directoryGrantId: randomUUID(),
    }),
    { code: "CREATION_CONTEXT_MISMATCH" },
  );
  await assert.rejects(
    access.resolveCreationContext(h.userId, h.caller, contextId, {
      kind: "local",
      deviceId: h.id,
      folderId,
    }),
    { code: "CREATION_CONTEXT_MISMATCH" },
  );
  await assert.rejects(
    schema.db
      .insert(schema.threads)
      .values({
        id: randomUUID(),
        teamId,
        workspaceId,
        createdBy: h.userId,
        title: "Invalid",
        executionTargetJson: { ...target, folderId },
      }),
  );
  await access.revokeFolderAccess(h.userId, h.id, folderId, h.caller);
  await assert.rejects(
    service.validateThreadExecutionTarget(h.userId, target),
    { code: "LOCAL_FOLDER_REVOKED" },
  );
  await assert.rejects(
    service.localCall({
      deviceId: h.id,
      userId: h.userId,
      threadId,
      caller: h.caller,
      action: "workspace.ensure",
      payload: { directoryGrantId: folderId },
    }),
    { code: "LOCAL_FOLDER_REVOKED" },
  );
});
