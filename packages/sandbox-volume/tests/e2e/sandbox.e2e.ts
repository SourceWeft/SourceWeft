import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { createCloudflareSandboxProviderFactory } from "@sourceweft/sandbox-provider-cloudflare";
import type { SandboxProvider } from "@sourceweft/builtin-tool-sandbox";
import { ContainerReplacedError, createVolumeHooks, type SandboxExecutor, type VolumeHooks } from "../../src/hooks/index";
import { cleanupVolume, createE2EContext, e2eEnabled, type E2EContext } from "./env";

/**
 * Sandbox e2e on the real Cloudflare dev bridge through the real provider package:
 * attach to an empty volume, sync a mixed tree, destroy + rebuild, refuse an unattached container,
 * checkpoint, roll back an acknowledged deletion. The helper binary comes from helper/dist
 * (run `pnpm helper:build` first) and is downloaded into the sandbox through a pre-signed URL,
 * which is also the production fallback for images that do not ship it.
 */
const MAX_OUTPUT = 4 * 1024 * 1024;
let ctx: E2EContext;
let provider: SandboxProvider;
let hooks: VolumeHooks;
const sandboxes: string[] = [];
let volumeId: string | null = null;

const FINGERPRINT = `cd /workspace && F() { find . -mindepth 1 \\( -path ./.sourceweft -o -name '.sourceweft*' \\) -prune -o "$@"; }
echo "FP content=$(F -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | cut -c1-16) meta=$( { F -type f -printf 'f %m %s %T@ %p\\n'; F -type d -printf 'd %m %p\\n'; F -type l -printf 'l %l %p\\n'; } | sort | sha256sum | cut -c1-16) files=$(F -type f | wc -l)"`;

function executorFor(sandboxId: string): SandboxExecutor {
  return {
    async execute(command, options) {
      const result = await provider.execute({ providerSandboxId: sandboxId, command, timeoutMs: options.timeoutMs, maxOutputChars: MAX_OUTPUT });
      return { output: result.output, exitCode: result.exitCode };
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

async function run(sandboxId: string, attachmentId: string, command: string, timeoutMs = 300_000) {
  const executor = executorFor(sandboxId);
  const result = await executor.execute(hooks.wrapCommand(command), { timeoutMs });
  return hooks.parseResult({ attachmentId, output: result.output, exitCode: result.exitCode, executor });
}

/** The stock image pre-creates these under /workspace; they are synced like anything else but are not part of the scenario. */
const IMAGE_DIRS = new Set(["input", "output", "work"]);
function paths(entries: Array<{ path: string }>): string[] {
  return entries.map((e) => e.path).filter((p) => !IMAGE_DIRS.has(p)).sort();
}

function fingerprint(output: string): string {
  const line = output.split("\n").find((l) => l.startsWith("FP "));
  assert.ok(line, `no fingerprint in output: ${output.slice(-300)}`);
  return line;
}

before(async () => {
  if (!e2eEnabled) return;
  ctx = await createE2EContext();
  provider = createCloudflareSandboxProviderFactory({ bridgeUrl: ctx.env.CF_SANDBOX_BRIDGE_URL!.replace(/\/$/, ""), apiKey: ctx.env.CF_SANDBOX_API_KEY!, maxOutputChars: MAX_OUTPUT }).createProvider();
  const helperKey = `${ctx.keyPrefix}bin/swvol`;
  await ctx.store.put(helperKey, readFileSync(resolve(process.cwd(), "helper/dist/swvol-x86_64")));
  hooks = createVolumeHooks({
    service: ctx.service,
    helper: { downloadUrl: () => ctx.store.presignGet(helperKey, 3600) },
    log: (event, fields) => console.log(`  [${event}] ${JSON.stringify(fields)}`),
  });
});

after(async () => {
  if (!ctx) return;
  for (const id of sandboxes) await provider.deleteSandbox(id).catch(() => undefined);
  if (volumeId) await cleanupVolume(ctx, volumeId);
  await ctx.store.deletePrefix(ctx.keyPrefix);
  await ctx.close();
});

test("a volume survives sandbox destruction, refuses unattached containers and can be rolled back", { skip: !e2eEnabled, timeout: 1_800_000 }, async () => {
  const first = await newSandbox();
  const attached = await hooks.attach({ scope: ctx.scope, sandboxId: first, executor: executorFor(first) });
  volumeId = attached.volumeId;
  assert.equal(attached.daemon, true, attached.output);
  assert.equal((attached.restore as { entries?: number })?.entries, 0);

  // T2: a mixed tree in one command; the barrier makes it durable before the result returns.
  const r1 = await run(first, attached.attachmentId, `cd /workspace && mkdir -p src/deep "dir with space" empty && printf 'hello\\n' > src/a.txt && head -c 3000000 /dev/urandom > src/deep/blob.bin && printf 'x' > "dir with space/中文.md" && : > zero.txt && ln -s src/a.txt link && ln -s nowhere dangling && chmod 600 src/a.txt && chmod 755 src/deep/blob.bin && touch -d '2024-01-02T03:04:05Z' src/a.txt && echo done`);
  assert.equal(r1.exitCode, 0, r1.output);
  assert.equal(r1.sync.persisted, true, JSON.stringify(r1.sync));
  assert.equal(r1.output.trim().endsWith("done"), true);
  let entries = await ctx.service.repo.entries(volumeId);
  assert.deepEqual(paths(entries), ["dangling", "dir with space", "dir with space/中文.md", "empty", "link", "src", "src/a.txt", "src/deep", "src/deep/blob.bin", "zero.txt"]);
  assert.equal(entries.find((e) => e.path === "src/a.txt")!.mode, 0o600);
  assert.equal(entries.find((e) => e.path === "dangling")!.linkTarget, "nowhere");

  // T5: delete, rename a directory, replace a directory by a file.
  const r2 = await run(first, attached.attachmentId, `cd /workspace && rm zero.txt && mv src moved && rmdir empty && echo file > empty && printf 'more\\n' >> moved/a.txt && echo ok`);
  assert.equal(r2.sync.persisted, true, JSON.stringify(r2.sync));
  entries = await ctx.service.repo.entries(volumeId);
  assert.deepEqual(paths(entries), ["dangling", "dir with space", "dir with space/中文.md", "empty", "link", "moved", "moved/a.txt", "moved/deep", "moved/deep/blob.bin"]);
  assert.equal(entries.find((e) => e.path === "empty")!.kind, "f");
  const headBeforeDelete = await ctx.service.repo.head(volumeId);
  const fpA = fingerprint((await run(first, attached.attachmentId, FINGERPRINT)).output);

  // T7: destroy the sandbox, attach a fresh one, the tree comes back identical.
  await provider.deleteSandbox(first);
  const second = await newSandbox();
  const reattached = await hooks.attach({ scope: ctx.scope, sandboxId: second, executor: executorFor(second) });
  assert.equal(reattached.volumeId, volumeId);
  assert.equal((reattached.restore as { ok?: boolean })?.ok, true, reattached.output);
  const fpB = fingerprint((await run(second, reattached.attachmentId, FINGERPRINT)).output);
  assert.equal(fpB, fpA, "restored tree must match the original byte for byte, including metadata");
  const r3 = await run(second, reattached.attachmentId, "cd /workspace && cat moved/a.txt && readlink link");
  assert.equal(r3.output.trim(), "hello\nmore\nsrc/a.txt");

  // T9: a container that was not restored in this boot cannot run commands or write the volume.
  await executorFor(second).execute("rm -f /workspace/.sourceweft/identity; kill $(cat /workspace/.sourceweft/daemon.pid) 2>/dev/null; true", { timeoutMs: 30_000 });
  await assert.rejects(run(second, reattached.attachmentId, "cd /workspace && rm -rf moved && echo should-not-run"), ContainerReplacedError);
  assert.equal(await ctx.service.repo.head(volumeId), headBeforeDelete, "nothing was synced from the unattached container");
  const recovered = await hooks.onContainerReplaced({ scope: ctx.scope, sandboxId: second, executor: executorFor(second) });
  const fpC = fingerprint((await run(second, recovered.attachmentId, FINGERPRINT)).output);
  assert.equal(fpC, fpA);

  // Checkpoint with nothing changed uploads nothing.
  const cp = await hooks.checkpoint({ attachmentId: recovered.attachmentId, executor: executorFor(second) });
  assert.equal(cp.sync.persisted, true);
  assert.equal(cp.sync.flush?.upserts ?? 0, 0);

  // Acknowledged deletion, then point-in-time rollback and a rebuild that brings the files back.
  const r4 = await run(second, recovered.attachmentId, "cd /workspace && rm -rf moved 'dir with space' empty link dangling && echo gone");
  assert.equal(r4.sync.persisted, true);
  assert.deepEqual(paths(await ctx.service.repo.entries(volumeId)), []);
  await ctx.service.rollback(volumeId, headBeforeDelete);
  await provider.deleteSandbox(second);
  const third = await newSandbox();
  const rolled = await hooks.attach({ scope: ctx.scope, sandboxId: third, executor: executorFor(third) });
  const fpD = fingerprint((await run(third, rolled.attachmentId, FINGERPRINT)).output);
  assert.equal(fpD, fpA, "rollback restores the exact tree");
  assert.equal(await ctx.service.repo.rejectCount(volumeId), 0);
});
