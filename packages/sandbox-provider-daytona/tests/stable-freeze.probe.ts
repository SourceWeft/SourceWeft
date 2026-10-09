import { DaytonaSandbox } from "@langchain/daytona";
import { sessionProbeEnv } from "../../builtin-tool-sandbox/tests/helpers/session-cancellation-probe";
import { probeStableFreeze } from "../../builtin-tool-sandbox/tests/helpers/stable-freeze-probe";
const env = sessionProbeEnv();
if (!env.DAYTONA_API_KEY || !env.DAYTONA_SANDBOX_SNAPSHOT)
  throw new Error("Configured Daytona key and original snapshot required");
let sandbox: DaytonaSandbox | undefined;
await probeStableFreeze({
  provider: "daytona",
  target: { snapshot: env.DAYTONA_SANDBOX_SNAPSHOT },
  create: async (purpose) => {
    sandbox = await DaytonaSandbox.create({
      auth: {
        apiKey: env.DAYTONA_API_KEY!,
        ...(env.DAYTONA_API_URL ? { apiUrl: env.DAYTONA_API_URL } : {}),
      },
      snapshot: env.DAYTONA_SANDBOX_SNAPSHOT,
      labels: { purpose },
      autoStopInterval: 5,
      autoDeleteInterval: 5,
      timeout: 120,
    });
    return sandbox.id;
  },
  execute: async (id, command) => {
    if (!sandbox || id !== sandbox.id)
      throw new Error("Probe sandbox identity mismatch");
    const result = await sandbox.instance.process.executeCommand(
      command,
      "/workspace",
      undefined,
      30,
    );
    return { output: result.result, exitCode: result.exitCode };
  },
  delete: async (id) => {
    if (!sandbox || id !== sandbox.id)
      throw new Error("Probe cleanup identity mismatch");
    await sandbox.close();
  },
});
