/**
 * The sidecar's entry point: strips every proxy environment variable before srt is ever
 * imported (the sidecar must run with none — see the design's Global Constraints), then
 * wires the real `SandboxManager` and `os.networkInterfaces()`-backed `ownAddresses` into
 * `startServer` over `process.stdin`/`process.stdout`.
 *
 * `--print-env` is test-only: it skips starting the server and instead prints, as a JSON
 * array, the names of whatever proxy variables are still in `process.env` after stripping
 * (expected to always be empty) — see `tests/server.test.ts`'s `main strips proxy variables`.
 *
 * `startServer` already runs `srt.reset()` (best effort) when its own request loop ends,
 * whether that was an explicit `shutdown` or `input` simply hitting EOF (see `server.ts`'s
 * `teardown`) — but `reset()` tearing down srt's state does not guarantee every socket/proxy
 * listener it started is gone, and any one of those left open would keep Node's event loop
 * alive indefinitely. So this process calls `process.exit(0)` itself right after `startServer`
 * resolves, rather than letting the event loop decide whether the process gets to exit: a
 * parent (the Tauri host) that crashed or was killed without sending `shutdown` must not be
 * left with an orphaned sidecar still holding sandbox proxies open (fix round 1 review).
 *
 * Fix round 2 review: that `process.exit(0)` can itself drop the very last line written to
 * `process.stdout` — the `shutdown` ack, or the last `wrap`/`probe` reply before EOF. When
 * stdout is a pipe (as it is under the real Rust host, never a TTY), `Writable.write()`
 * queues the chunk and returns before the data has actually reached the OS; `process.exit()`
 * tears the process down immediately, with no guarantee that queued write has gone out yet.
 * `flushStdout` (below) is called, and awaited, before every `process.exit(0)` in this file
 * for exactly this reason.
 */
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

/** Bounds how long `flushStdout` waits for `process.stdout` to drain before giving up on it. */
const STDOUT_FLUSH_GRACE_MS = 2_000;

/**
 * Waits until every write already queued on `process.stdout` has actually been handed to the
 * underlying resource, bounded by `graceMs` (after which it gives up and resolves anyway,
 * rather than hang a process that must exit either way). Writable streams invoke their write
 * callbacks in the same order the writes were queued, so queuing one more, zero-length write
 * and waiting for *its* callback is a reliable barrier: by the time it fires, every write
 * queued before it — in particular, whatever `startServer`'s final `output.write(...)` call
 * just queued — has already been handed off too. (`writableNeedDrain`/`'drain'` would cover
 * the same backpressure case, but this barrier covers it as well, without needing to branch
 * on whether backpressure actually occurred.)
 */
function flushStdout(graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, graceMs);
    timer.unref?.();
    process.stdout.write("", finish);
  });
}

const PROXY_VAR_NAMES = new Set(["http_proxy", "https_proxy", "all_proxy", "no_proxy"]);

/** Deletes every proxy variable (any case) from `process.env`. Exported for the test above. */
export function stripProxyEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (PROXY_VAR_NAMES.has(key.toLowerCase())) {
      delete env[key];
    }
  }
}

function remainingProxyVarNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((key) => PROXY_VAR_NAMES.has(key.toLowerCase()));
}

/** Every address bound to this host's own network interfaces, loopback and link-local included. */
function ownAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      addresses.add(info.address);
    }
  }
  return addresses;
}

/**
 * Linux only: a fresh 0700 directory that becomes this process's `TMPDIR` (so srt's
 * `os.tmpdir()`) before srt is imported. srt puts its bridge sockets there, and the policy
 * re-allows reading exactly this directory under the Linux `/` read deny (see `buildConfig`),
 * which keeps the shared `/tmp` itself unreadable inside the sandbox. Removed on exit.
 */
function createRuntimeDir(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const dir = mkdtempSync(join(os.tmpdir(), "sourceweft-srt-"));
  process.env.TMPDIR = dir;
  return dir;
}

async function main(): Promise<void> {
  // Strip proxy variables before anything else touches `process.env` — in particular, before
  // srt is imported below. A static top-level `import` of srt would run its module-level code
  // (and any proxy-reading init it does) before this function's first line, so srt is loaded
  // with a dynamic `import()` only after stripping.
  stripProxyEnv(process.env);

  if (process.argv.includes("--print-env")) {
    process.stdout.write(`${JSON.stringify(remainingProxyVarNames(process.env))}\n`);
    await flushStdout(STDOUT_FLUSH_GRACE_MS);
    process.exit(0);
    return;
  }

  const runtimeDir = createRuntimeDir();

  const [{ SandboxManager }, { startServer }] = await Promise.all([
    import("@anthropic-ai/sandbox-runtime"),
    import("./server.js"),
  ]);

  await startServer(process.stdin, process.stdout, {
    srt: SandboxManager,
    ownAddresses,
    runtimeDir,
  });
  if (runtimeDir !== undefined) rmSync(runtimeDir, { recursive: true, force: true });

  // See the module doc comment: flush the last queued write (the `shutdown` ack, or whatever
  // was written right before EOF) before forcing the exit — forcing it is still necessary,
  // since srt's own listeners can keep the event loop alive after `startServer` has already
  // resolved, but it must not race the pipe write that resolution just queued.
  await flushStdout(STDOUT_FLUSH_GRACE_MS);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
