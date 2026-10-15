import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createCloudflareSandboxProviderFactory } from "@sourceweft/sandbox-provider-cloudflare";
import { createVolumeHooks, type SandboxExecutor } from "../../src/hooks/index";
import {
  cleanupE2EContext,
  createE2EContext,
  e2eEnabled,
  loadBackendEnv,
} from "./env";

// Explicit destructive fixture opt-in. Only newly-created sandbox IDs and this context's
// random object prefix/schema are touched. It exercises capture/WAL storage; production
// supervisor admission and protected file RPCs have their own integration suite.
const enabled = e2eEnabled && process.env.SANDBOX_VOLUME_FAULT_E2E === "1";
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

test(
  "network disconnect and whole-instance loss preserve acknowledged bytes and report the unconfirmed window separately",
  { skip: !enabled, timeout: 900_000 },
  async () => {
    const settings = loadBackendEnv();
    assert.ok(
      settings.CF_SANDBOX_BRIDGE_URL && settings.CF_SANDBOX_API_KEY,
      "fault test requires explicit Cloudflare bridge credentials",
    );
    const ctx = await createE2EContext();
    const reportDir = mkdtempSync(join(tmpdir(), "swvol-fault-ledger-"));
    const ledgerPath = join(reportDir, "ledger.jsonl");
    const record = (event: Record<string, unknown>) => {
      const fd = openSync(ledgerPath, "a");
      try {
        appendFileSync(
          fd,
          JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    const sandboxes = new Set<string>();
    const provider = createCloudflareSandboxProviderFactory({
      bridgeUrl: ctx.env.CF_SANDBOX_BRIDGE_URL!.replace(/\/$/, ""),
      apiKey: ctx.env.CF_SANDBOX_API_KEY!,
      maxOutputChars: 10000,
    }).createProvider();
    const executor = (id: string): SandboxExecutor => ({
      execute: async (command, options) => {
        const result = await provider.execute({
          providerSandboxId: id,
          command,
          timeoutMs: options.timeoutMs,
          maxOutputChars: 10000,
        });
        return { output: result.output, exitCode: result.exitCode };
      },
    });
    const create = async () => {
      const sandbox = await provider.createSandbox({
        labels: { purpose: "sandbox-volume-fault-e2e" },
        ttlSeconds: 900,
      });
      sandboxes.add(sandbox.id);
      for (let attempt = 0; attempt < 30; attempt++) {
        const ready = await executor(sandbox.id).execute("true", {
          timeoutMs: 10000,
        });
        if (ready.exitCode === 0) return sandbox.id;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("fault-test sandbox did not become ready");
    };
    try {
      const helperKey = `${ctx.keyPrefix}bin/swvol`;
      await ctx.store.put(
        helperKey,
        readFileSync(resolve(process.cwd(), "helper/dist/swvol-x86_64")),
      );
      const hooks = createVolumeHooks({
        service: ctx.service,
        helper: { downloadUrl: () => ctx.store.presignGet(helperKey, 3600) },
      });
      const first = await create();
      const attached = await hooks.attach({
        scope: ctx.scope,
        sandboxId: first,
        executor: executor(first),
      });
      const expected = createHash("sha256");
      for (let i = 0; i < 262144; i++)
        expected.update(
          createHash("sha256").update(`fault-seed:${i}`).digest(),
        );
      const expectedHash = expected.digest("hex");
      record({
        event: "intent",
        operation: "confirmed-base",
        path: "durable/confirmed.bin",
        bytes: 8 * 1024 * 1024,
        sha256: expectedHash,
      });
      const write = `import hashlib,pathlib
p=pathlib.Path('/workspace/durable');p.mkdir(exist_ok=True)
with (p/'confirmed.bin').open('wb') as f:
 for i in range(262144): f.write(hashlib.sha256(('fault-seed:'+str(i)).encode()).digest())`;
      const executed = await executor(first).execute(
        hooks.wrapCommand(`python3 -c ${quote(write)}`),
        { timeoutMs: 300000 },
      );
      const confirmed = await hooks.parseResult({
        attachmentId: attached.attachmentId,
        output: executed.output,
        exitCode: executed.exitCode,
        executor: executor(first),
      });
      assert.equal(confirmed.exitCode, 0);
      assert.equal(confirmed.sync.persisted, true);
      record({
        event: "confirmed",
        operation: "confirmed-base",
        seq: confirmed.sync.confirmedSeq,
      });

      const actor = (await ctx.service.repo.getAttachment(
        attached.attachmentId,
      ))!;
      const plan = await ctx.service.plan(actor);
      const entry = plan.entries.find(
        (entry) => entry.p === "durable/confirmed.bin",
      )!;
      assert.ok(entry?.c.length);
      const pack = plan.chunks[entry.c[0]![0]]![0];
      const url = plan.packs[pack]!;
      const controller = new AbortController();
      const response = await fetch(url, { signal: controller.signal });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const firstBytes = await reader.read();
      assert.ok(firstBytes.value && firstBytes.value.byteLength > 0);
      const total = Number(response.headers.get("content-length"));
      assert.ok(
        total > firstBytes.value.byteLength,
        "fault must interrupt a partial response, not an already-complete object",
      );
      controller.abort(new Error("intentional fault-test disconnect"));
      await assert.rejects(reader.read());
      record({
        event: "transport_disconnected",
        deliveredBytes: firstBytes.value.byteLength,
        totalBytes: total,
        confirmedSeq: confirmed.sync.confirmedSeq,
      });
      const retried = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      assert.equal(retried.status, 200);
      assert.equal((await retried.arrayBuffer()).byteLength, total);
      assert.equal(
        await ctx.service.confirmPersistence(
          attached.attachmentId,
          confirmed.sync.confirmedSeq,
        ),
        true,
      );

      record({
        event: "intent",
        operation: "unconfirmed-writer",
        path: "durable/unconfirmed.bin",
        ringCapacityBytes: 64 * 1024 * 1024,
        continuouslyWriting: true,
        acknowledged: false,
      });
      const writer = `import itertools,json,os,pathlib,time
f=open('/workspace/durable/unconfirmed.bin','wb',buffering=0)
for i in itertools.count():
 f.seek((i%64)*1048576);f.write(bytes([i%256])*1048576);os.fsync(f.fileno())
 pathlib.Path('/tmp/swvol-fault-progress.tmp').write_text(json.dumps({'pid':os.getpid(),'iteration':i,'bytes':os.fstat(f.fileno()).st_size}))
 os.replace('/tmp/swvol-fault-progress.tmp','/tmp/swvol-fault-progress.json');time.sleep(0.25)`;
      const started = await executor(first).execute(
        `nohup setsid python3 -c ${quote(writer)} >/tmp/swvol-fault-writer.log 2>&1 </dev/null & echo WRITER_STARTED`,
        { timeoutMs: 30000 },
      );
      assert.equal(started.exitCode, 0);
      let firstProgress:
        { pid: number; iteration: number; bytes: number } | undefined;
      let lastProgress:
        { pid: number; iteration: number; bytes: number } | undefined;
      const probeScript =
        "import json,os,pathlib; p=pathlib.Path('/tmp/swvol-fault-progress.json'); s=json.loads(p.read_text()) if p.exists() else None; os.kill(s['pid'],0) if s else None; print(json.dumps(s))";
      for (let attempt = 0; attempt < 40; attempt++) {
        const probe = await executor(first).execute(
          `python3 -c ${quote(probeScript)}`,
          { timeoutMs: 10000 },
        );
        assert.equal(
          probe.exitCode,
          0,
          "continuous writer must still be alive",
        );
        const progress = JSON.parse(probe.output.trim()) as
          typeof firstProgress | null;
        if (progress) {
          if (!firstProgress) firstProgress = progress;
          lastProgress = progress;
          if (
            progress.pid === firstProgress.pid &&
            progress.iteration > firstProgress.iteration
          )
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(
        firstProgress &&
          lastProgress &&
          lastProgress.pid === firstProgress.pid &&
          lastProgress.iteration > firstProgress.iteration,
        "need two advancing fsynced writes from the same live process before destroying the instance",
      );
      assert.ok(
        lastProgress.bytes > 0 && lastProgress.bytes <= 64 * 1024 * 1024,
      );
      record({
        event: "continuous_write_proven_without_barrier",
        operation: "unconfirmed-writer",
        first: firstProgress,
        last: lastProgress,
      });
      await provider.deleteSandbox(first);
      sandboxes.delete(first);
      record({
        event: "instance_destroyed",
        operation: "unconfirmed-writer",
        acknowledged: false,
      });
      const second = await create();
      const recovered = await hooks.onContainerReplaced({
        scope: ctx.scope,
        sandboxId: second,
        previousSandboxId: first,
        executor: executor(second),
      });
      const inspected = await executor(second).execute(
        "sha256sum /workspace/durable/confirmed.bin; if [ -f /workspace/durable/unconfirmed.bin ]; then stat -c 'UNCONFIRMED_BYTES=%s' /workspace/durable/unconfirmed.bin; else echo UNCONFIRMED_ABSENT; fi",
        { timeoutMs: 30000 },
      );
      assert.equal(inspected.exitCode, 0);
      assert.equal(
        inspected.output.trim().split(/\s+/)[0],
        expectedHash,
        "an acknowledged file must survive whole-instance loss byte-for-byte",
      );
      const restored = /UNCONFIRMED_BYTES=(\d+)/.exec(inspected.output)?.[1];
      record({
        event: "recovery_verified",
        confirmed: {
          sha256: expectedHash,
          seq: confirmed.sync.confirmedSeq,
          restored: true,
        },
        unconfirmed: {
          acknowledged: false,
          outcome:
            restored === undefined
              ? "absent"
              : Number(restored) < 64 * 1024 * 1024
                ? "partial"
                : "present_without_ack",
          restoredBytes: restored === undefined ? 0 : Number(restored),
        },
        recoveredAttachment: recovered.attachmentId,
      });
      console.log(`fault ledger: ${ledgerPath}`);
    } catch (error) {
      record({
        event: "test_failed",
        errorType: error instanceof Error ? error.name : "unknown",
      });
      console.log(`fault ledger: ${ledgerPath}`);
      throw error;
    } finally {
      await cleanupE2EContext(ctx, { provider, sandboxIds: sandboxes });
    }
  },
);
