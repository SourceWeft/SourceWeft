import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import {
  SandboxManager,
  SourceWeftSandboxBackend,
  maxSandboxCommandTimeoutMs,
  resolveSandboxCommandTimeoutMs,
  type SandboxOperationStore,
  type SandboxProvider,
  type SandboxRuntimeContext,
  type SandboxRuntimeLimits,
  type SandboxStore,
} from "@sourceweft/builtin-tool-sandbox";
import { createCloudflareSandboxProviderFactory } from "@sourceweft/sandbox-provider-cloudflare";
import { createVolumeHooks } from "../../src/hooks/index";
import { cleanupVolume, createE2EContext, e2eEnabled, type E2EContext } from "./env";

/**
 * The integrated path on the real Cloudflare dev bridge: SandboxManager + SourceWeftSandboxBackend
 * (the code the agent runtime uses) with the real provider and the real hooks. Covers transparent
 * re-attach inside `execute` when the container was replaced, and shadow mode.
 */
const MAX_OUTPUT = 4 * 1024 * 1024;
let ctx: E2EContext;
let provider: SandboxProvider;
const sandboxes: string[] = [];
const volumes: string[] = [];

const limits: SandboxRuntimeLimits = {
  ttlSeconds: 1800,
  commandBudgetsMs: { interactive: 300_000, batch: 600_000 },
  maxCommandTimeoutMs: 900_000,
  maxOutputChars: MAX_OUTPUT,
  maxPrepareFileBytes: 1_000_000,
  maxPrepareTotalBytes: 1_000_000,
  maxCollectFileBytes: 1_000_000,
  maxCollectTotalBytes: 1_000_000,
};

function stores(providerSandboxId: string, context: SandboxRuntimeContext): { sandboxStore: SandboxStore; operationStore: SandboxOperationStore } {
  return {
    sandboxStore: {
      async findLatestActiveThreadSandbox() {
        return { id: `record-${providerSandboxId}`, provider: "cloudflare", providerSandboxId, teamId: context.teamId, workspaceId: context.workspaceId, threadId: context.threadId, userId: context.userId, status: "ready", updatedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) };
      },
      async markCreatingSandboxError() { return true; },
      async insertCreatingSandbox() { return true; },
      async markSandboxReady() { return true; },
      async markSandboxExpired() { return true; },
      async releaseReadyThreadSandboxLease() { return 1; },
      async touchSandbox() { return true; },
    },
    operationStore: {
      async listMessageOperations() { return []; },
      async findLatestToolOperation() { return null; },
      async insertRunningToolOperation() { return true; },
      async findLatestActiveToolOperation() { return null; },
      async markStaleRunningToolOperationFailed() { return false; },
      async completeToolOperation() {},
      async recordOperation() {},
      async findSucceededOperationByToolCall() { return null; },
    },
  };
}

async function newSandbox(): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const { id } = await provider.createSandbox({ labels: { purpose: "sandbox-volume-e2e" }, ttlSeconds: 1800 });
      sandboxes.push(id);
      for (let i = 0; i < 60; i++) {
        const probe = await provider.execute({ providerSandboxId: id, command: "true", timeoutMs: 30_000, maxOutputChars: 1000 }).catch(() => null);
        if (probe && probe.exitCode === 0) return id;
        await new Promise((r) => setTimeout(r, 5000));
      }
      throw new Error("sandbox never became ready");
    } catch (error) {
      if (!/capacity|503/.test(String(error))) throw error;
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
  throw new Error("no sandbox capacity");
}

function backendFor(providerSandboxId: string, context: SandboxRuntimeContext, shadow: boolean) {
  const helperKey = `${ctx.keyPrefix}bin/swvol`;
  const hooks = createVolumeHooks({ service: ctx.service, shadow, helper: { downloadUrl: () => ctx.store.presignGet(helperKey, 3600) } });
  const manager = new SandboxManager({ provider, ...stores(providerSandboxId, context), ttlSeconds: limits.ttlSeconds, maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits), volume: hooks });
  const backend = new SourceWeftSandboxBackend({ manager, context, limits, commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }), toolApprovalEnabled: true });
  return { backend, manager };
}

before(async () => {
  if (!e2eEnabled) return;
  ctx = await createE2EContext();
  provider = createCloudflareSandboxProviderFactory({ bridgeUrl: ctx.env.CF_SANDBOX_BRIDGE_URL!.replace(/\/$/, ""), apiKey: ctx.env.CF_SANDBOX_API_KEY!, maxOutputChars: MAX_OUTPUT }).createProvider();
  await ctx.store.put(`${ctx.keyPrefix}bin/swvol`, readFileSync(resolve(process.cwd(), "helper/dist/swvol-x86_64")));
});

after(async () => {
  if (!ctx) return;
  for (const id of sandboxes) await provider.deleteSandbox(id).catch(() => undefined);
  for (const id of volumes) await cleanupVolume(ctx, id);
  await ctx.store.deletePrefix(ctx.keyPrefix);
  await ctx.close();
});

test("the agent execute path attaches, syncs, and re-attaches a replaced container transparently", { skip: !e2eEnabled, timeout: 1_200_000 }, async () => {
  const context: SandboxRuntimeContext = { ...ctx.scope, userId: "user-e2e", messageId: "m1", runId: "r1", sandboxExecuteToolCallId: "tool-call-execute" };
  const sandboxId = await newSandbox();
  const { backend } = backendFor(sandboxId, context, false);
  const first = await backend.execute("cd /workspace && mkdir -p app && echo 'console.log(1)' > app/index.js && echo written");
  assert.equal(first.exitCode, 0);
  assert.equal(first.output.trim(), "written", "the marker never reaches the model");
  const volume = await ctx.service.repo.findVolume(ctx.scope);
  assert.ok(volume);
  volumes.push(volume.id);
  const paths = (await ctx.service.repo.entries(volume.id)).map((e) => e.path);
  assert.ok(paths.includes("app/index.js"), paths.join(","));

  // Simulate the provider silently handing back an empty container under the same id.
  await provider.execute({ providerSandboxId: sandboxId, command: "kill $(cat /workspace/.sourceweft/daemon.pid) 2>/dev/null; rm -rf /workspace/.sourceweft /workspace/app", timeoutMs: 30_000, maxOutputChars: 1000 });
  const second = await backend.execute("cd /workspace && cat app/index.js");
  assert.equal(second.exitCode, 0, second.output);
  assert.equal(second.output.trim(), "console.log(1)", "the volume was restored before the command ran");
});

test("shadow mode syncs the sandbox into the volume but never restores", { skip: !e2eEnabled, timeout: 1_200_000 }, async () => {
  // A second thread scope so the shadow volume is independent.
  const scope = { ...ctx.scope, threadId: (await ctx.pool.query("select id from threads where id <> $1 limit 1", [ctx.scope.threadId])).rows[0]?.id ?? ctx.scope.threadId };
  const context: SandboxRuntimeContext = { ...scope, userId: "user-e2e", messageId: "m2", runId: "r2", sandboxExecuteToolCallId: "tool-call-execute" };
  const sandboxId = await newSandbox();
  await provider.execute({ providerSandboxId: sandboxId, command: "mkdir -p /workspace/pre && echo existing > /workspace/pre/file.txt", timeoutMs: 30_000, maxOutputChars: 1000 });
  const { backend } = backendFor(sandboxId, context, true);
  const result = await backend.execute("cd /workspace && echo new > created.txt && echo ok");
  assert.equal(result.output.trim(), "ok");
  const volume = await ctx.service.repo.findVolume(scope);
  assert.ok(volume);
  volumes.push(volume.id);
  const paths = (await ctx.service.repo.entries(volume.id)).map((e) => e.path);
  assert.ok(paths.includes("pre/file.txt") && paths.includes("created.txt"), `shadow volume mirrors the sandbox: ${paths.join(",")}`);
  const headBefore = await ctx.service.repo.head(volume.id);

  // A fresh sandbox in shadow mode gets nothing back; the volume then mirrors the empty tree.
  const fresh = await newSandbox();
  const { backend: shadowBackend } = backendFor(fresh, context, true);
  const probe = await shadowBackend.execute("ls /workspace/pre /workspace/created.txt 2>&1; true");
  assert.match(probe.output, /No such file/);
  const after = (await ctx.service.repo.entries(volume.id)).map((e) => e.path);
  assert.ok(!after.includes("created.txt"), `the volume follows the sandbox in shadow mode: ${after.join(",")}`);
  assert.ok((await ctx.service.repo.entriesAt(volume.id, headBefore)).some((e) => e.path === "created.txt"), "history keeps what the first sandbox had");
});
