import { readFileSync } from "node:fs";
import { CloudflareSandboxProvider } from "../src/cloudflare-provider";
import { redactSandboxText } from "../../builtin-tool-sandbox/src/runtime/redaction";
import { sessionProbeEnv } from "../../builtin-tool-sandbox/tests/helpers/session-cancellation-probe";
const env = sessionProbeEnv();
const provider = new CloudflareSandboxProvider({
  bridgeUrl: env.CF_SANDBOX_BRIDGE_URL!,
  apiKey: env.CF_SANDBOX_API_KEY!,
  maxOutputChars: 10_000,
});
let id: string | undefined;
try {
  id = (
    await provider.createSandbox({
      ttlSeconds: 600,
      labels: { purpose: "sourceweft-pid-namespace-boundary-probe" },
    })
  ).id;
  console.log(
    JSON.stringify({ event: "probe-sandbox-created", sandboxId: id }),
  );
  const script = readFileSync(
    new URL(
      "../../builtin-tool-sandbox/tests/fixtures/pid-namespace-boundary.py",
      import.meta.url,
    ),
    "utf8",
  );
  const result = await provider.executeSystem({
    providerSandboxId: id,
    timeoutMs: 40_000,
    maxOutputChars: 10_000,
    command: `python3 - <<'SWVOL_NAMESPACE_PROBE'\n${script}\nSWVOL_NAMESPACE_PROBE`,
  });
  console.log(redactSandboxText(result.output));
  if (result.exitCode !== 0)
    throw new Error(`PID namespace probe failed with exit ${result.exitCode}`);
} catch (error) {
  console.error(
    JSON.stringify({
      error:
        error instanceof Error
          ? redactSandboxText(error.message)
          : "PID namespace probe failed",
    }),
  );
  process.exitCode = 1;
} finally {
  if (id) {
    await provider.deleteSandbox(id);
    console.log(
      JSON.stringify({ event: "probe-sandbox-deleted", sandboxId: id }),
    );
  }
}
