import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { database, closeDatabase } from "@sourceweft/db";
import { localProviderForTurn } from "../modules/devices/provider";
import { tokenHash } from "../modules/devices/service";

// Real HTTP + PostgreSQL regression tests. Offline device rows are explicitly test
// fixtures; these checks do NOT claim to be the native-client execution E2E.
if (
  !new URL(process.env.DATABASE_URL!).pathname.startsWith(
    "/sourceweft_local_pc_e2e_",
  )
)
  throw new Error("Refusing non-E2E database");
const root = new URL(
  "../../../../output/playwright/local-pc/",
  import.meta.url,
);
const fixture = JSON.parse(
  await readFile(new URL("environment.private.json", root), "utf8"),
);
const base = "http://localhost:3101";
const login = await fetch(`${base}/api/auth/sign-in/email`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: "http://localhost:3100",
  },
  body: JSON.stringify({ email: fixture.email, password: fixture.password }),
});
assert.equal(login.status, 200, "Real authentication must succeed");
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
assert(cookie);
const workspace = (
  await database.query(
    "SELECT id,organization_id FROM workspaces WHERE id=$1 AND created_by=$2",
    [fixture.workspaceId, fixture.userId],
  )
).rows[0];
assert(workspace);
const tests: Array<{
  name: string;
  status: "passed" | "failed";
  error?: string;
}> = [];
const ids: Record<string, string> = {};
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    tests.push({ name, status: "passed" });
    console.log(`PASS ${name}`);
  } catch (error) {
    tests.push({ name, status: "failed", error: String(error) });
    throw error;
  }
}
async function request(path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie,
      origin: "http://localhost:3100",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function create(title: string, executionTarget?: unknown) {
  const response = await request(`/v1/workspaces/${workspace.id}/threads`, {
    title,
    ...(executionTarget ? { executionTarget } : {}),
  });
  const value = await response.json();
  assert.equal(response.status, 201, JSON.stringify(value));
  return value.thread;
}
async function pgRejected(sql: string, values: unknown[], message: RegExp) {
  await assert.rejects(
    database.query(sql, values),
    (error: any) => error.code === "23514" && message.test(error.message),
  );
}
try {
  const a = randomUUID(),
    b = randomUUID(),
    foreign = randomUUID();
  for (const [id, owner, name] of [
    [a, fixture.userId, "Binding check A (offline fixture)"],
    [b, fixture.userId, "Binding check B (offline fixture)"],
    [foreign, `fixture-other-${randomUUID()}`, "Foreign offline fixture"],
  ]) {
    await database.query(
      "INSERT INTO local_devices(id,user_id,name,token_hash) VALUES($1,$2,$3,$4)",
      [id, owner, name, tokenHash(randomBytes(32).toString("hex"))],
    );
  }
  ids.deviceA = a;
  ids.deviceB = b;
  let cloud: any, local: any;
  await check(
    "Creation fixes cloud target and creates no local binding",
    async () => {
      cloud = await create("Binding regression — cloud");
      ids.cloudThread = cloud.id;
      assert.deepEqual(cloud.executionTarget, { kind: "cloud" });
      assert.equal(
        (
          await database.query(
            "SELECT * FROM local_thread_bindings WHERE thread_id=$1",
            [cloud.id],
          )
        ).rowCount,
        0,
      );
    },
  );
  await check(
    "Local creation atomically fixes PC binding even while offline",
    async () => {
      local = await create("Binding regression — local", {
        kind: "local",
        deviceId: a,
      });
      ids.localThread = local.id;
      assert.deepEqual(local.executionTarget, { kind: "local", deviceId: a });
      const binding = (
        await database.query(
          "SELECT * FROM local_thread_bindings WHERE thread_id=$1",
          [local.id],
        )
      ).rows[0];
      assert.equal(binding.device_id, a);
      assert.equal(binding.user_id, fixture.userId);
      assert.equal(binding.local_workspace_id, null);
    },
  );
  await check(
    "HTTP rejects cloud to local, local to cloud, and local to another PC",
    async () => {
      for (const [threadId, body] of [
        [cloud.id, { deviceId: a }],
        [local.id, { kind: "cloud" }],
        [local.id, { deviceId: b }],
      ]) {
        const response = await request(
          `/v1/workspaces/${workspace.id}/threads/${threadId}/local-execution`,
          body,
        );
        assert.equal(response.status, 409);
        assert.equal(
          (await response.json()).code,
          "EXECUTION_TARGET_IMMUTABLE",
        );
      }
    },
  );
  await check(
    "PostgreSQL independently rejects all execution target updates",
    async () => {
      await pgRejected(
        "UPDATE threads SET execution_target_json=$2 WHERE id=$1",
        [cloud.id, JSON.stringify({ kind: "local", deviceId: a })],
        /EXECUTION_TARGET_IMMUTABLE/,
      );
      await pgRejected(
        "UPDATE threads SET execution_target_json=$2 WHERE id=$1",
        [local.id, JSON.stringify({ kind: "cloud" })],
        /EXECUTION_TARGET_IMMUTABLE/,
      );
      await pgRejected(
        "UPDATE threads SET execution_target_json=$2 WHERE id=$1",
        [local.id, JSON.stringify({ kind: "local", deviceId: b })],
        /EXECUTION_TARGET_IMMUTABLE/,
      );
      await pgRejected(
        "UPDATE local_thread_bindings SET device_id=$2 WHERE thread_id=$1",
        [local.id, b],
        /LOCAL_BINDING_TARGET_MISMATCH|EXECUTION_TARGET_IMMUTABLE/,
      );
    },
  );
  await check(
    "Cannot graft a local binding onto a cloud conversation",
    async () => {
      await pgRejected(
        "INSERT INTO local_thread_bindings(thread_id,device_id,user_id) VALUES($1,$2,$3)",
        [cloud.id, a, fixture.userId],
        /LOCAL_BINDING_TARGET_MISMATCH/,
      );
    },
  );
  await check(
    "Assigned local workspace cannot be switched or cleared",
    async () => {
      await database.query(
        "UPDATE local_thread_bindings SET local_workspace_id='fixture-root',workspace_path='/fixture/not-a-real-workspace' WHERE thread_id=$1",
        [local.id],
      );
      await pgRejected(
        "UPDATE local_thread_bindings SET local_workspace_id='another-root',workspace_path='/fixture/other' WHERE thread_id=$1",
        [local.id],
        /LOCAL_WORKSPACE_IMMUTABLE/,
      );
      await pgRejected(
        "UPDATE local_thread_bindings SET local_workspace_id=NULL,workspace_path=NULL WHERE thread_id=$1",
        [local.id],
        /LOCAL_WORKSPACE_IMMUTABLE/,
      );
    },
  );
  await check(
    "Metadata edits preserve target; sharing a local thread is rejected",
    async () => {
      await database.query("UPDATE threads SET title=$2 WHERE id=$1", [
        local.id,
        "Binding regression — local (renamed)",
      ]);
      await pgRejected(
        "UPDATE threads SET visibility='workspace' WHERE id=$1",
        [local.id],
        /LOCAL_THREAD_MUST_BE_PRIVATE/,
      );
      const response = await request(
        `/v1/workspaces/${workspace.id}/threads/${local.id}/local-execution`,
      );
      const value = await response.json();
      assert.deepEqual(value.executionTarget, { kind: "local", deviceId: a });
      assert.equal(value.target.online, false);
    },
  );
  await check(
    "Foreign and malformed targets fail without creating a thread",
    async () => {
      const prefix = `invalid-binding-${randomUUID()}`;
      for (const target of [
        { kind: "local", deviceId: foreign },
        { kind: "local", deviceId: randomUUID() },
        { kind: "local" },
        { kind: "cloud", deviceId: a },
      ]) {
        const response = await request(
          `/v1/workspaces/${workspace.id}/threads`,
          { title: prefix, executionTarget: target },
        );
        assert(
          [400, 404].includes(response.status),
          `Unexpected status ${response.status}`,
        );
      }
      assert.equal(
        (
          await database.query("SELECT id FROM threads WHERE title=$1", [
            prefix,
          ])
        ).rowCount,
        0,
      );
    },
  );
  const context = (threadId: string) => ({
    teamId: workspace.organization_id,
    workspaceId: workspace.id,
    threadId,
    userId: fixture.userId,
    messageId: randomUUID(),
    runId: randomUUID(),
  });
  await check(
    "Offline local runtime fails closed instead of returning cloud",
    async () => {
      await assert.rejects(
        localProviderForTurn(context(local.id)),
        (error: any) => error.code === "DEVICE_OFFLINE",
      );
      assert.equal(
        (
          await database.query(
            "SELECT id FROM local_tool_invocations WHERE thread_id=$1",
            [local.id],
          )
        ).rowCount,
        0,
      );
      assert.equal(await localProviderForTurn(context(cloud.id)), null);
    },
  );
  await check(
    "Missing local binding fails closed; it is never inferred as cloud",
    async () => {
      const missing = await create("Binding regression — missing binding", {
        kind: "local",
        deviceId: a,
      });
      ids.missingBindingThread = missing.id;
      await database.query(
        "DELETE FROM local_thread_bindings WHERE thread_id=$1",
        [missing.id],
      );
      try {
        await assert.rejects(
          localProviderForTurn(context(missing.id)),
          (error: any) => error.code === "LOCAL_BINDING_INVALID",
        );
      } finally {
        await database.query(
          "INSERT INTO local_thread_bindings(thread_id,device_id,user_id) VALUES($1,$2,$3)",
          [missing.id, a, fixture.userId],
        );
      }
    },
  );
  await check(
    "Concurrent switch attempts leave both targets unchanged",
    async () => {
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          request(
            `/v1/workspaces/${workspace.id}/threads/${i % 2 ? local.id : cloud.id}/local-execution`,
            { deviceId: i % 2 ? b : a },
          ),
        ),
      );
      assert(responses.every((response) => response.status === 409));
      for (const [id, target] of [
        [cloud.id, { kind: "cloud" }],
        [local.id, { kind: "local", deviceId: a }],
      ]) {
        assert.deepEqual(
          (
            await database.query(
              "SELECT execution_target_json FROM threads WHERE id=$1",
              [id],
            )
          ).rows[0].execution_target_json,
          target,
        );
      }
    },
  );
} finally {
  await writeFile(
    new URL("binding-verification.json", root),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        kind: "real-http-and-postgresql-regression",
        nativeExecutionE2E: false,
        tests,
        ids,
      },
      null,
      2,
    ),
  );
  await closeDatabase();
}
