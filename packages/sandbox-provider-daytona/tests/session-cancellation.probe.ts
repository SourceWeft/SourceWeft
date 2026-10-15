import { redactSandboxText } from "../../builtin-tool-sandbox/src/runtime/redaction";
import { DaytonaSandbox } from "@langchain/daytona";
import {
  probeSessionCancellation,
  sessionProbeEnv,
} from "../../builtin-tool-sandbox/tests/helpers/session-cancellation-probe";

const env = sessionProbeEnv();
if (!env.DAYTONA_API_KEY) throw new Error("Daytona API key is required");
if (!env.DAYTONA_SANDBOX_SNAPSHOT && !env.DAYTONA_SANDBOX_IMAGE)
  throw new Error("Explicit Daytona snapshot or image is required");
let sandbox: DaytonaSandbox | undefined;
await probeSessionCancellation({
  provider: "daytona",
  async createSandbox(purpose) {
    sandbox = await DaytonaSandbox.create({
      auth: {
        apiKey: env.DAYTONA_API_KEY!,
        ...(env.DAYTONA_API_URL ? { apiUrl: env.DAYTONA_API_URL } : {}),
      },
      ...(env.DAYTONA_SANDBOX_SNAPSHOT
        ? { snapshot: env.DAYTONA_SANDBOX_SNAPSHOT }
        : { image: env.DAYTONA_SANDBOX_IMAGE! }),
      labels: { purpose, sourceweft: "session-cancellation-probe" },
      autoStopInterval: 5,
      autoDeleteInterval: 5,
      timeout: 120,
    });
    console.log(
      JSON.stringify({
        provider: "daytona",
        event: "probe-sandbox-created",
        sandboxId: sandbox.id,
      }),
    );
  },
  async createSession(id) {
    await sandbox!.instance.process.createSession(id);
  },
  async execute(command, sessionId) {
    if (sessionId) {
      const result = await sandbox!.instance.process.executeSessionCommand(
        sessionId,
        { command },
        60,
      );
      return { output: result.output ?? "", exitCode: result.exitCode ?? null };
    }
    const result = await sandbox!.instance.process.executeCommand(
      command,
      "/workspace",
      undefined,
      60,
    );
    return { output: result.result, exitCode: result.exitCode };
  },
  async deleteSession(id) {
    await sandbox!.instance.process.deleteSession(id);
  },
  async deleteSandbox() {
    await sandbox!.close();
    console.log(
      JSON.stringify({
        provider: "daytona",
        event: "probe-sandbox-deleted",
        sandboxId: sandbox!.id,
      }),
    );
  },
}).catch((error: unknown) => {
  console.error(
    JSON.stringify({
      provider: "daytona",
      error:
        error instanceof Error
          ? redactSandboxText(error.message)
          : "session cancellation probe failed",
    }),
  );
  process.exitCode = 1;
});
