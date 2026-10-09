import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFileSync,
  appendFileSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { parseCommandOutput } from "../../src/protocol/marker";
import { test } from "node:test";
import { createCloudflareSandboxProviderFactory } from "@sourceweft/sandbox-provider-cloudflare";
import { createVolumeHooks, type SandboxExecutor } from "../../src/hooks/index";
import {
  cleanupE2EContext,
  createE2EContext,
  e2eEnabled,
  loadBackendEnv,
} from "./env";

// Explicitly destructive and bandwidth-heavy: only this context's generated
// schema/object prefix and newly created sandbox IDs are touched. This proves
// capture/WAL/eager restore, not protected runtime admission or every POSIX write.
const enabled = e2eEnabled && process.env.SANDBOX_VOLUME_GIB_E2E === "1";
const SIZE_GIB = process.env.SANDBOX_VOLUME_GIB_SIZE ?? "1";
assert.match(SIZE_GIB, /^[12]$/, "GB test size must explicitly be 1 or 2 GiB");
const FILES = 128 * Number(SIZE_GIB);
const FILE_BYTES = 8 * 1024 * 1024;
const TOTAL_BYTES = FILES * FILE_BYTES;
const SEED = "swvol-cloud-gib-228-v1";
const MTIME = "1704164645000000123";
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

const generate = `import hashlib,os,pathlib,json,time
root=pathlib.Path('/workspace/gib');root.mkdir()
free=os.statvfs('/workspace').f_bavail*os.statvfs('/workspace').f_frsize
if free < ${TOTAL_BYTES}+268435456: raise RuntimeError('insufficient disk for unchanged ${SIZE_GIB}GiB test')
started=time.monotonic()
for i in range(${FILES}):
 p=root/('file-%03d.bin'%i)
 with p.open('wb') as f:
  f.write(hashlib.shake_256(('${SEED}:'+str(i)).encode()).digest(${FILE_BYTES}))
  f.flush();os.fsync(f.fileno())
 os.chmod(p,0o600 if i%2==0 else 0o755);os.utime(p,ns=(${MTIME},${MTIME}))
os.symlink('file-000.bin',root/'link');os.utime(root/'link',ns=(${MTIME},${MTIME}),follow_symlinks=False)
os.chmod(root,0o750);os.utime(root,ns=(${MTIME},${MTIME}))
stats=[os.stat(root/('file-%03d.bin'%i)) for i in range(${FILES})]
print('GIB '+json.dumps({'event':'generated','files':len(stats),'bytes':sum(x.st_size for x in stats),'allocated':sum(x.st_blocks*512 for x in stats),'seconds':time.monotonic()-started}))`;
const verify = `import os,pathlib,hashlib,json,stat,time
root=pathlib.Path('/workspace/gib');records=[];started=time.monotonic()
for p in sorted(root.iterdir()):
 s=p.lstat()
 if stat.S_ISREG(s.st_mode):
  h=hashlib.sha256()
  with p.open('rb') as f:
   for b in iter(lambda:f.read(1048576),b''): h.update(b)
  records.append([p.name,s.st_size,stat.S_IMODE(s.st_mode),str(s.st_mtime_ns),h.hexdigest()])
 elif stat.S_ISLNK(s.st_mode):
  assert p.name=='link' and os.readlink(p)=='file-000.bin' and s.st_mtime_ns==${MTIME}
 else: raise RuntimeError('unexpected entry')
s=root.stat();assert stat.S_IMODE(s.st_mode)==0o750 and s.st_mtime_ns==${MTIME}
print('GIB '+json.dumps({'event':'verified','bytes':sum(x[1] for x in records),'records':records,'seconds':time.monotonic()-started}))`;

function event(output: string): Record<string, unknown> {
  const line = output.split("\n").find((s) => s.startsWith("GIB "));
  assert.ok(line, `missing independent result: ${output.slice(-1500)}`);
  return JSON.parse(line.slice(4));
}
function expected(): unknown[][] {
  return Array.from({ length: FILES }, (_, i) => {
    const bytes = createHash("shake256", { outputLength: FILE_BYTES })
      .update(`${SEED}:${i}`)
      .digest();
    return [
      `file-${String(i).padStart(3, "0")}.bin`,
      FILE_BYTES,
      i % 2 === 0 ? 0o600 : 0o755,
      MTIME,
      createHash("sha256").update(bytes).digest("hex"),
    ];
  });
}

test(
  `real ${SIZE_GIB}GiB incompressible cloud volume survives instance deletion with independent content and metadata verification`,
  { skip: !enabled, timeout: 3_600_000 },
  async () => {
    const settings = loadBackendEnv();
    assert.ok(
      settings.CF_SANDBOX_BRIDGE_URL && settings.CF_SANDBOX_API_KEY,
      "explicit Cloudflare credentials required before creating any test resources",
    );
    const oracle = expected();
    const ctx = await createE2EContext();
    const provider = createCloudflareSandboxProviderFactory({
      bridgeUrl: ctx.env.CF_SANDBOX_BRIDGE_URL!.replace(/\/$/, ""),
      apiKey: ctx.env.CF_SANDBOX_API_KEY!,
      maxOutputChars: 100_000,
    }).createProvider();
    const evidence = mkdtempSync(join(tmpdir(), "swvol-cloud-gib-diagnostic-"));
    const preserveFailure =
      process.env.SANDBOX_VOLUME_GIB_PRESERVE_FAILURE === "1";
    let succeeded = false;
    const redact = (value: unknown): unknown => {
      if (typeof value === "string")
        return value.replace(/https?:\/\/[^\s"'<>]+/g, "[redacted URL]");
      if (Array.isArray(value)) return value.map(redact);
      if (value !== null && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, redact(item)]),
        );
      return value;
    };
    console.log("GIB_EVIDENCE", evidence);
    const sandboxes = new Set<string>();
    const volumes = new Set<string>();
    const executor = (id: string): SandboxExecutor => ({
      execute: async (command, options) => {
        const r = await provider.execute({
          providerSandboxId: id,
          command,
          timeoutMs: options.timeoutMs,
          maxOutputChars: 100_000,
        });
        const parsed = parseCommandOutput(r.output);
        const diagnostic = redact({
          at: new Date().toISOString(),
          stage: command.includes("flush") ? "barrier" : "operation",
          exitCode: r.exitCode,
          markerFound: parsed.markerFound,
          flushExitCode: parsed.flushExitCode,
          flush: parsed.flush,
          output: r.output,
        });
        appendFileSync(
          join(evidence, "responses.jsonl"),
          JSON.stringify(diagnostic) + "\n",
          { mode: 0o600 },
        );
        if (
          r.exitCode !== 0 ||
          (parsed.markerFound && parsed.flushExitCode !== 0)
        )
          console.log(
            "GIB_DIAGNOSTIC",
            JSON.stringify(
              redact({
                exitCode: r.exitCode,
                markerFound: parsed.markerFound,
                flushExitCode: parsed.flushExitCode,
                flush: parsed.flush,
                output: parsed.markerFound ? undefined : r.output,
              }),
            ),
          );
        return { output: r.output, exitCode: r.exitCode };
      },
    });
    const create = async () => {
      const sandbox = await provider.createSandbox({
        labels: { purpose: "sandbox-volume-gib-e2e" },
        ttlSeconds: 3600,
      });
      sandboxes.add(sandbox.id);
      for (let i = 0; i < 60; i++) {
        const r = await executor(sandbox.id).execute("true", {
          timeoutMs: 10000,
        });
        if (r.exitCode === 0) return sandbox.id;
        await new Promise((done) => setTimeout(done, 1000));
      }
      throw new Error("GB sandbox did not become ready");
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
        log: (name, fields) => console.log(name, JSON.stringify(fields)),
      });
      const first = await create();
      const attached = await hooks.attach({
        scope: ctx.scope,
        sandboxId: first,
        executor: executor(first),
      });
      volumes.add(attached.volumeId);
      assert.equal(attached.daemon, true);
      const machine = await executor(first).execute(
        `python3 -c ${quote("import os,platform,json; m=dict(x.split(':',1) for x in open('/proc/meminfo') if ':' in x); v=os.statvfs('/workspace'); print('GIB_MACHINE '+json.dumps({'architecture':platform.machine(),'kernel':platform.release(),'reportedCpuCount':os.cpu_count(),'procMemTotalBytes':int(m['MemTotal'].split()[0])*1024,'workspaceAvailableBytes':v.f_bavail*v.f_frsize}))")}`,
        { timeoutMs: 30_000 },
      );
      assert.equal(machine.exitCode, 0, machine.output);
      console.log(machine.output.trim());
      console.log(
        "GIB_HELPER_SHA256",
        createHash("sha256")
          .update(
            readFileSync(resolve(process.cwd(), "helper/dist/swvol-x86_64")),
          )
          .digest("hex"),
      );
      const started = performance.now();
      const raw = await executor(first).execute(
        hooks.wrapCommand(`python3 -c ${quote(generate)}`),
        { timeoutMs: 900_000 },
      );
      const confirmed = await hooks.parseResult({
        attachmentId: attached.attachmentId,
        output: raw.output,
        exitCode: raw.exitCode,
        executor: executor(first),
      });
      assert.equal(confirmed.exitCode, 0, confirmed.output);
      assert.equal(
        confirmed.sync.persisted,
        true,
        JSON.stringify(confirmed.sync),
      );
      const generated = event(confirmed.output);
      assert.equal(generated.bytes, TOTAL_BYTES);
      assert.ok(
        Number(generated.allocated) >= TOTAL_BYTES,
        "no sparse source files",
      );
      const original = await executor(first).execute(
        `python3 -c ${quote(verify)}`,
        { timeoutMs: 300_000 },
      );
      assert.equal(original.exitCode, 0, original.output);
      assert.deepEqual(event(original.output).records, oracle);
      const actor = await ctx.service.repo.getAttachment(attached.attachmentId);
      assert.ok(actor);
      const plan = await ctx.service.plan(actor);
      const packKeys = Object.keys(plan.packs);
      let storedPackBytes = 0;
      for (const pack of packKeys) {
        const size = await ctx.store.size(
          `${ctx.keyPrefix}vol/${attached.volumeId}/${pack}`,
        );
        assert.ok(size !== null, `confirmed pack missing: ${pack}`);
        storedPackBytes += size;
      }
      assert.ok(
        storedPackBytes >= TOTAL_BYTES * 0.95,
        "physical R2 pack bytes must witness the incompressible workload",
      );
      console.log(
        "GIB_METRIC",
        JSON.stringify({
          event: "confirmed",
          seed: SEED,
          sourceBytes: TOTAL_BYTES,
          sourceAllocatedBytes: generated.allocated,
          storedPackBytes,
          packs: packKeys.length,
          confirmedSeq: confirmed.sync.confirmedSeq,
          milliseconds: performance.now() - started,
        }),
      );
      await provider.deleteSandbox(first);
      sandboxes.delete(first);
      const second = await create();
      const restoreStarted = performance.now();
      const restored = await hooks.onContainerReplaced({
        scope: ctx.scope,
        sandboxId: second,
        previousSandboxId: first,
        executor: executor(second),
      });
      assert.equal(restored.volumeId, attached.volumeId);
      assert.equal(
        (restored.restore as { ok?: boolean })?.ok,
        true,
        restored.output,
      );
      const check = await executor(second).execute(
        `python3 -c ${quote(verify)}`,
        { timeoutMs: 300_000 },
      );
      assert.equal(check.exitCode, 0, check.output);
      const checked = event(check.output);
      assert.equal(checked.bytes, TOTAL_BYTES);
      assert.deepEqual(
        checked.records,
        oracle,
        "fresh instance must match the external oracle",
      );
      console.log(
        "GIB_METRIC",
        JSON.stringify({
          event: "restored",
          actualReadBytes: checked.bytes,
          files: FILES,
          milliseconds: performance.now() - restoreStarted,
        }),
      );
      succeeded = true;
    } catch (error) {
      const tables = await ctx.pool.query(
        "select table_name from information_schema.tables where table_schema=current_schema()",
      );
      for (const row of tables.rows) {
        const name = String(row.table_name);
        assert.match(name, /^[a-z_]+$/);
        const result = await ctx.pool.query(`select * from "${name}"`);
        writeFileSync(
          join(evidence, name + ".json"),
          JSON.stringify(result.rows),
          { mode: 0o600 },
        );
      }
      const schema = await ctx.pool.query("select current_schema() as schema");
      writeFileSync(
        join(evidence, "resources.json"),
        JSON.stringify({
          schema: schema.rows[0].schema,
          keyPrefix: ctx.keyPrefix,
          sandboxes: [...sandboxes],
          volumes: [...volumes],
          sizeGiB: SIZE_GIB,
          preserveFailure,
        }),
        { mode: 0o600 },
      );
      throw error;
    } finally {
      if (!succeeded && preserveFailure) {
        await ctx.close({ preserveSchema: true });
        console.log("GIB_RETAINED_FOR_DIAGNOSIS", evidence);
      } else {
        await cleanupE2EContext(ctx, {
          provider,
          sandboxIds: sandboxes,
          volumeIds: volumes,
        });
      }
    }
  },
);
