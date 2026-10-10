import { readFileSync } from "node:fs";
import { DaytonaSandbox } from "@langchain/daytona";
import { redactSandboxText } from "../../builtin-tool-sandbox/src/runtime/redaction";
import { sessionProbeEnv } from "../../builtin-tool-sandbox/tests/helpers/session-cancellation-probe";
const env = sessionProbeEnv();
if (!env.DAYTONA_API_KEY || !env.DAYTONA_SANDBOX_SNAPSHOT)
  throw new Error("Configured Daytona key and snapshot required");
let sandbox: DaytonaSandbox | undefined;
try {
  sandbox = await DaytonaSandbox.create({
    auth: {
      apiKey: env.DAYTONA_API_KEY,
      ...(env.DAYTONA_API_URL ? { apiUrl: env.DAYTONA_API_URL } : {}),
    },
    snapshot: env.DAYTONA_SANDBOX_SNAPSHOT,
    labels: { purpose: "sourceweft-workload-capabilities-probe" },
    autoStopInterval: 5,
    autoDeleteInterval: 5,
    timeout: 120,
  });
  console.log(
    JSON.stringify({ event: "probe-sandbox-created", sandboxId: sandbox.id }),
  );
  const script = readFileSync(
    new URL(
      "../../builtin-tool-sandbox/tests/fixtures/workload-capabilities.py",
      import.meta.url,
    ),
    "utf8",
  );
  const result = await sandbox.instance.process.executeCommand(
    `python3 - <<'SWVOL_NAMESPACE_PROBE'\n${script}\nSWVOL_NAMESPACE_PROBE`,
    "/workspace",
    undefined,
    40,
  );
  console.log(redactSandboxText(result.result));
  if (result.exitCode !== 0)
    throw new Error(`Workload capabilities probe failed with exit ${result.exitCode}`);
} catch (error) {
  console.error(
    JSON.stringify({
      error:
        error instanceof Error
          ? redactSandboxText(error.message)
          : "Workload capabilities probe failed",
    }),
  );
  process.exitCode = 1;
} finally {
  if (sandbox) {
    await sandbox.close();
    console.log(
      JSON.stringify({ event: "probe-sandbox-deleted", sandboxId: sandbox.id }),
    );
  }
}
