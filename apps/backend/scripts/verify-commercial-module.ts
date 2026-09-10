import "dotenv/config";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createIsolatedTestDatabase } from "../src/test/isolated-database";

const root = fileURLToPath(new URL("../../../", import.meta.url));
// Isolated database and queue only; this never switches the running deployment.
const isolated = await createIsolatedTestDatabase("billing_test");
const base: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: isolated.url,
  SOURCEWEFT_EDITION: undefined,
  SOURCEWEFT_SAAS_ENABLED: "false",
  BACKEND_BILLING_PROVIDER: "none",
  BACKEND_BILLING_MODE: "shadow",
  BACKEND_TEAM_BILLING_ENABLED: "false",
  BACKEND_BILLING_RECONCILE_ENABLED: "false",
  BACKEND_CREDITS_ENABLED: "true",
  BACKEND_PAGES_ENABLED: "true",
  BACKEND_API_HOST: "127.0.0.1",
  BACKEND_API_PORT: "3411",
  NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:3411",
  NEXT_PUBLIC_WEB_BASE_URL: "http://127.0.0.1:3412",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  MODEL_GATEWAY_ENCRYPTION_SECRET: process.env.MODEL_GATEWAY_ENCRYPTION_SECRET,
  MAIL_PROVIDER: "console",
  MARKET_ENABLED: "false",
  JOB_QUEUE_NAME: `commercial-matrix-${randomBytes(6).toString("hex")}`,
};
function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = root,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${args[0]} exited ${code}`)),
    );
  });
}
const startupOnly = process.argv.includes("--startup-only");
try {
  for (const edition of ["core", "commercial"]) {
    const enabled = edition === "commercial";
    const env = {
      ...base,
      SOURCEWEFT_COMMERCIAL_ENABLED: String(enabled),
      BACKEND_BILLING_MODE: enabled ? "shadow" : "disabled",
      BACKEND_CREDITS_ENABLED: String(enabled),
      BACKEND_PAGES_ENABLED: String(enabled),
      E2E_EDITION: edition,
      E2E_API_URL: "http://127.0.0.1:3411",
    };
    await run(["scripts/e2e/billing-startup.mjs"], env);
    if (startupOnly) continue;
    const api = spawn(process.execPath, ["dist/api.js"], {
      cwd: root + "apps/backend",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostics = "";
    api.stdout.on("data", (data) => {
      diagnostics = (diagnostics + data).slice(-6000);
    });
    api.stderr.on("data", (data) => {
      diagnostics = (diagnostics + data).slice(-6000);
    });
    try {
      await run(["scripts/e2e/billing-editions.mjs"], env);
      console.log(
        `PASS: ${edition} real API/auth/billing checks from the same build`,
      );
    } catch (error) {
      console.error(diagnostics);
      throw error;
    } finally {
      api.kill("SIGTERM");
      if (api.exitCode === null)
        await new Promise<void>((resolve) => api.once("exit", () => resolve()));
    }
  }
  if (startupOnly) {
    console.log("PASS: both module states started workers and schedulers");
  } else {
    const pnpm = process.env.COMMERCIAL_TEST_PNPM;
    if (!pnpm)
      throw new Error(
        "COMMERCIAL_TEST_PNPM must point to the selected pnpm executable",
      );
    await run([pnpm, "--filter", "@sourceweft/billing", "test:database"], {
      ...base,
      SOURCEWEFT_COMMERCIAL_ENABLED: "true",
    });
  }
} finally {
  await isolated.close();
}
