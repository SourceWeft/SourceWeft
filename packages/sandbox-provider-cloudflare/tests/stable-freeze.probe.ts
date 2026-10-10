import { CloudflareSandboxProvider } from "../src/cloudflare-provider";
import { sessionProbeEnv } from "../../builtin-tool-sandbox/tests/helpers/session-cancellation-probe";
import { probeStableFreeze } from "../../builtin-tool-sandbox/tests/helpers/stable-freeze-probe";
const env = sessionProbeEnv();
if (!env.CF_SANDBOX_BRIDGE_URL || !env.CF_SANDBOX_API_KEY)
  throw new Error("Configured Cloudflare bridge credentials required");
const privilegedStages = [
  "SANDBOX_FREEZE_KERNEL_TEST",
  "SANDBOX_FREEZE_ASYNC_BOUNDARY",
  "SANDBOX_FREEZE_NATIVE_AIO",
  "SANDBOX_FREEZE_SUPERVISOR_TEST",
].some((key) => process.env[key] === "1");
const endpoint = new URL(env.CF_SANDBOX_BRIDGE_URL);
if (
  privilegedStages &&
  !(
    endpoint.protocol === "https:" &&
    endpoint.hostname.startsWith("sourceweft-swvol-supervisor-228-dev.") &&
    endpoint.hostname.endsWith(".workers.dev")
  )
) {
  throw new Error(
    "SANDBOX_FREEZE_DEV_WORKER_REQUIRED: root diagnostic stages are restricted to the explicitly authorized isolated dev Worker.",
  );
}
const provider = new CloudflareSandboxProvider({
  bridgeUrl: env.CF_SANDBOX_BRIDGE_URL,
  apiKey: env.CF_SANDBOX_API_KEY,
  maxOutputChars: 30_000,
});
await probeStableFreeze({
  provider: "cloudflare",
  target: { endpointHost: new URL(env.CF_SANDBOX_BRIDGE_URL).hostname },
  create: async (purpose) =>
    (await provider.createSandbox({ ttlSeconds: 600, labels: { purpose } })).id,
  execute: async (id, command) =>
    provider.executeSystem({
      providerSandboxId: id,
      command,
      timeoutMs: 30_000,
      maxOutputChars: 30_000,
    }),
  delete: (id) => provider.deleteSandbox(id),
});
