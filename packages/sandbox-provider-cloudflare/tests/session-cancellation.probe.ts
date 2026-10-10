import { redactSandboxText } from "../../builtin-tool-sandbox/src/runtime/redaction";
import { parseSseStream, extractSseText } from "../src/cloudflare-provider";
import {
  probeSessionCancellation,
  sessionProbeEnv,
} from "../../builtin-tool-sandbox/tests/helpers/session-cancellation-probe";

const env = sessionProbeEnv();
if (!env.CF_SANDBOX_BRIDGE_URL || !env.CF_SANDBOX_API_KEY)
  throw new Error("Cloudflare bridge credentials are required");
let sandboxId: string | undefined;
async function request(
  method: string,
  path: string,
  body?: unknown,
  sessionId?: string,
) {
  const result = await fetch(`${env.CF_SANDBOX_BRIDGE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_SANDBOX_API_KEY}`,
      "Content-Type": "application/json",
      ...(sessionId ? { "Session-Id": sessionId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(65_000),
  }).catch((error: unknown) => {
    const detail = error as { cause?: { code?: string }; name?: string };
    throw new Error(
      `Cloudflare ${method} ${path} failed: ${detail.cause?.code ?? detail.name ?? "unknown"}`,
    );
  });
  if (!result.ok)
    throw new Error(`Cloudflare session probe HTTP ${result.status}`);
  return result;
}
const route = () => `/v1/sandbox/${encodeURIComponent(sandboxId!)}`;
await probeSessionCancellation({
  provider: "cloudflare",
  async createSandbox() {
    const result = (await (await request("POST", "/v1/sandbox")).json()) as {
      id?: string;
    };
    if (!result.id) throw new Error("Cloudflare probe create returned no ID");
    sandboxId = result.id;
    console.log(
      JSON.stringify({
        provider: "cloudflare",
        event: "probe-sandbox-created",
        sandboxId,
      }),
    );
  },
  async createSession(id) {
    await request("POST", `${route()}/session`, { id, cwd: "/workspace" });
  },
  async execute(command, sessionId) {
    const result = await request(
      "POST",
      `${route()}/exec`,
      { argv: ["sh", "-lc", command], timeout_ms: 60_000 },
      sessionId,
    );
    if (!result.body) throw new Error("Cloudflare probe missing stream");
    let output = "";
    let exitCode: number | null = null;
    for await (const item of parseSseStream(result.body)) {
      if (item.event === "stdout" || item.event === "stderr")
        output += extractSseText(item.data);
      if (item.event === "exit")
        exitCode = (JSON.parse(item.data) as { exit_code: number }).exit_code;
      if (item.event === "error")
        throw new Error("Cloudflare session probe command failed");
    }
    return { output, exitCode };
  },
  async deleteSession(id) {
    const result = (await (
      await request("DELETE", `${route()}/session/${encodeURIComponent(id)}`)
    ).json()) as { success?: boolean };
    if (result.success !== true)
      throw new Error("Cloudflare session deletion was not confirmed");
  },
  async deleteSandbox() {
    await request("DELETE", route());
    console.log(
      JSON.stringify({
        provider: "cloudflare",
        event: "probe-sandbox-deleted",
        sandboxId,
      }),
    );
  },
}).catch((error: unknown) => {
  console.error(
    JSON.stringify({
      provider: "cloudflare",
      error:
        error instanceof Error
          ? redactSandboxText(error.message)
          : "session cancellation probe failed",
    }),
  );
  process.exitCode = 1;
});
