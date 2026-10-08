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
import {
  cleanupE2EContext,
  createE2EContext,
  e2eEnabled,
  type E2EContext,
} from "./env";

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

function stores(
  providerSandboxId: string,
  context: SandboxRuntimeContext,
): { sandboxStore: SandboxStore; operationStore: SandboxOperationStore } {
  return {
    sandboxStore: {
      async findLatestActiveThreadSandbox() {
        return {
          id: `record-${providerSandboxId}`,
          provider: "cloudflare",
          providerSandboxId,
          teamId: context.teamId,
          workspaceId: context.workspaceId,
          threadId: context.threadId,
          userId: context.userId,
          status: "ready",
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() + 3600_000),
        };
      },
      async markCreatingSandboxError() {
        return true;
      },
      async insertCreatingSandbox() {
        return true;
      },
      async markSandboxReady() {
        return true;
      },
      async markSandboxExpired() {
        return true;
      },
      async releaseReadyThreadSandboxLease() {
        return 1;
      },
      async touchSandbox() {
        return true;
      },
    },
    operationStore: {
      async listMessageOperations() {
        return [];
      },
      async findLatestToolOperation() {
        return null;
      },
      async insertRunningToolOperation() {
        return true;
      },
      async findLatestActiveToolOperation() {
        return null;
      },
      async markStaleRunningToolOperationFailed() {
        return false;
      },
      async completeToolOperation() {},
      async recordOperation() {},
      async findSucceededOperationByToolCall() {
        return null;
      },
    },
  };
}

async function newSandbox(): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const { id } = await provider.createSandbox({
        labels: { purpose: "sandbox-volume-e2e" },
        ttlSeconds: 1800,
      });
      sandboxes.push(id);
      for (let i = 0; i < 60; i++) {
        const probe = await provider
          .execute({
            providerSandboxId: id,
            command: "true",
            timeoutMs: 30_000,
            maxOutputChars: 1000,
          })
          .catch(() => null);
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

function backendFor(
  providerSandboxId: string,
  context: SandboxRuntimeContext,
  shadow: boolean,
) {
  const helperKey = `${ctx.keyPrefix}bin/swvol`;
  const hooks = createVolumeHooks({
    service: ctx.service,
    shadow,
    helper: { downloadUrl: () => ctx.store.presignGet(helperKey, 3600) },
  });
  const manager = new SandboxManager({
    provider,
    ...stores(providerSandboxId, context),
    ttlSeconds: limits.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(limits),
    volume: hooks,
  });
  const backend = new SourceWeftSandboxBackend({
    manager,
    context,
    limits,
    commandTimeoutMs: resolveSandboxCommandTimeoutMs({ limits }),
    toolApprovalEnabled: true,
  });
  return { backend, manager };
}

before(async () => {
  if (!e2eEnabled) return;
  ctx = await createE2EContext();
  provider = createCloudflareSandboxProviderFactory({
    bridgeUrl: ctx.env.CF_SANDBOX_BRIDGE_URL!.replace(/\/$/, ""),
    apiKey: ctx.env.CF_SANDBOX_API_KEY!,
    maxOutputChars: MAX_OUTPUT,
  }).createProvider();
  await ctx.store.put(
    `${ctx.keyPrefix}bin/swvol`,
    readFileSync(resolve(process.cwd(), "helper/dist/swvol-x86_64")),
  );
});

after(async () => {
  if (ctx)
    await cleanupE2EContext(ctx, {
      provider,
      sandboxIds: sandboxes,
      volumeIds: volumes,
    });
});

test(
  "the agent execute path syncs and preserves unconfirmed files when helper state is damaged",
  { skip: !e2eEnabled, timeout: 1_200_000 },
  async () => {
    const context: SandboxRuntimeContext = {
      ...ctx.scope,
      userId: "user-e2e",
      messageId: "m1",
      runId: "r1",
      sandboxExecuteToolCallId: "tool-call-execute",
    };
    const sandboxId = await newSandbox();
    const { backend } = backendFor(sandboxId, context, false);
    const first = await backend.execute(
      "cd /workspace && mkdir -p app && echo 'console.log(1)' > app/index.js && echo written",
    );
    assert.equal(first.exitCode, 0);
    assert.equal(
      first.output.trim(),
      "written",
      "the marker never reaches the model",
    );
    const volume = await ctx.service.repo.findVolume(ctx.scope);
    assert.ok(volume);
    volumes.push(volume.id);
    const paths = (await ctx.service.repo.entries(volume.id)).map(
      (e) => e.path,
    );
    assert.ok(paths.includes("app/index.js"), paths.join(","));

    // Missing helper state in the same boot is not proof of container replacement.
    await provider.execute({
      providerSandboxId: sandboxId,
      command:
        "kill $(cat /workspace/.sourceweft/daemon.pid) 2>/dev/null; rm -f /workspace/.sourceweft/identity; echo unsaved > /workspace/preserve-unsaved.txt",
      timeoutMs: 30_000,
      maxOutputChars: 1000,
    });
    await assert.rejects(
      backend.execute("cd /workspace && rm preserve-unsaved.txt"),
      /persistence|helper|unconfirmed/i,
    );
    const remaining = await provider.execute({
      providerSandboxId: sandboxId,
      command: "cat /workspace/preserve-unsaved.txt /workspace/app/index.js",
      timeoutMs: 30_000,
      maxOutputChars: 1000,
    });
    assert.equal(remaining.output.trim(), "unsaved\nconsole.log(1)");
  },
);

test(
  "shadow mode syncs the sandbox into the volume but never restores",
  { skip: !e2eEnabled, timeout: 1_200_000 },
  async () => {
    const scope = ctx.scope;
    const primaryBefore = await ctx.service.repo.findVolume(scope);
    const context: SandboxRuntimeContext = {
      ...scope,
      userId: "user-e2e",
      messageId: "m2",
      runId: "r2",
      sandboxExecuteToolCallId: "tool-call-execute",
    };
    const sandboxId = await newSandbox();
    await provider.execute({
      providerSandboxId: sandboxId,
      command:
        "mkdir -p /workspace/pre && echo existing > /workspace/pre/file.txt",
      timeoutMs: 30_000,
      maxOutputChars: 1000,
    });
    const { backend } = backendFor(sandboxId, context, true);
    const result = await backend.execute(
      "cd /workspace && echo new > created.txt && echo ok",
    );
    assert.match(result.output, /^ok/);
    assert.equal(result.durability?.status, "pending");
    const observed = await ctx.pool.query(
      "select v.id from sandbox_volumes v join sandbox_volume_attachments a on a.volume_id = v.id where v.thread_id = $1 and v.namespace like 'shadow:%' and a.sandbox_id = $2",
      [scope.threadId, sandboxId],
    );
    assert.equal(observed.rowCount, 1);
    const volume = await ctx.service.repo.getVolume(observed.rows[0].id);
    assert.ok(volume);
    volumes.push(volume.id);
    const paths = (await ctx.service.repo.entries(volume.id)).map(
      (e) => e.path,
    );
    assert.ok(
      paths.includes("pre/file.txt") && paths.includes("created.txt"),
      `shadow volume mirrors the sandbox: ${paths.join(",")}`,
    );
    const headBefore = await ctx.service.repo.head(volume.id);

    // A fresh sandbox starts a distinct observation; neither the primary volume nor
    // the earlier observation can receive deletions inferred from this empty tree.
    const fresh = await newSandbox();
    const { backend: shadowBackend } = backendFor(fresh, context, true);
    const probe = await shadowBackend.execute(
      "ls /workspace/pre /workspace/created.txt 2>&1; true",
    );
    assert.match(probe.output, /No such file/);
    const after = (await ctx.service.repo.entries(volume.id)).map(
      (e) => e.path,
    );
    assert.ok(
      after.includes("created.txt"),
      `the previous observation stays intact: ${after.join(",")}`,
    );
    assert.ok(
      (await ctx.service.repo.entriesAt(volume.id, headBefore)).some(
        (e) => e.path === "created.txt",
      ),
      "history keeps what the first sandbox had",
    );
    assert.deepEqual(await ctx.service.repo.findVolume(scope), primaryBefore);
    const observations = await ctx.pool.query(
      "select id from sandbox_volumes where thread_id = $1 and namespace like 'shadow:%'",
      [scope.threadId],
    );
    assert.equal(observations.rowCount, 2);
  },
);
