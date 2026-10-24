/**
 * The sidecar's entry point: strips every proxy environment variable before srt is ever
 * imported (the sidecar must run with none — see the design's Global Constraints), then
 * wires the real `SandboxManager` and `os.networkInterfaces()`-backed `ownAddresses` into
 * `startServer` over `process.stdin`/`process.stdout`.
 *
 * `--print-env` is test-only: it skips starting the server and instead prints, as a JSON
 * array, the names of whatever proxy variables are still in `process.env` after stripping
 * (expected to always be empty) — see `tests/server.test.ts`'s `main strips proxy variables`.
 */
import * as os from "node:os";

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

async function main(): Promise<void> {
  // Strip proxy variables before anything else touches `process.env` — in particular, before
  // srt is imported below. A static top-level `import` of srt would run its module-level code
  // (and any proxy-reading init it does) before this function's first line, so srt is loaded
  // with a dynamic `import()` only after stripping.
  stripProxyEnv(process.env);

  if (process.argv.includes("--print-env")) {
    process.stdout.write(`${JSON.stringify(remainingProxyVarNames(process.env))}\n`);
    process.exit(0);
    return;
  }

  const [{ SandboxManager }, { startServer }] = await Promise.all([
    import("@anthropic-ai/sandbox-runtime"),
    import("./server.js"),
  ]);

  await startServer(process.stdin, process.stdout, {
    srt: SandboxManager,
    ownAddresses,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
