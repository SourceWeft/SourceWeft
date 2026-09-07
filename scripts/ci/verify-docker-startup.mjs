import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// This job owns fresh PostgreSQL/Redis services. Never load a developer's .env.
assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "Run in GitHub Actions with job-local services",
);
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64", "Startup checks require native Linux amd64");
for (const key of ["DATABASE_URL", "REDIS_URL"]) {
  assert.ok(process.env[key], `${key} is required`);
  assert.equal(
    new URL(process.env[key]).hostname,
    "127.0.0.1",
    `${key} must use the job-local service`,
  );
}

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = join(root, "output/ci/docker-startup");
const image = process.argv[2] ?? "sourceweft:pr-test";
const prefix = `sourceweft-ci-${randomUUID().slice(0, 8)}`;
const containers = new Set();
const authSecret = randomBytes(32).toString("hex");
const modelSecret = randomBytes(32).toString("hex");
const report = {
  image,
  commit: process.env.GITHUB_SHA,
  stages: [],
  passed: false,
};
let directory;

function redact(value) {
  let text = String(value);
  for (const secret of [
    authSecret,
    modelSecret,
    process.env.DATABASE_URL,
    process.env.REDIS_URL,
  ]) {
    text = text.replaceAll(secret, "<redacted>");
  }
  return text;
}

async function docker(args, timeout = 30_000) {
  const result = await execute("docker", args, {
    cwd: root,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  return (result.stdout + result.stderr).trim();
}
async function state(name) {
  return JSON.parse(
    await docker(["inspect", name, "--format", "{{json .State}}"]),
  );
}
async function logs(name) {
  return docker(["logs", "--tail", "2000", name]);
}
async function recordLogs(name) {
  await writeFile(join(output, `${name}.log`), redact(await logs(name)), {
    mode: 0o600,
  });
}
async function waitFor(name, predicate) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    assert.equal(
      (await state(name)).Running,
      true,
      `${name} exited before readiness`,
    );
    if (await predicate()) return;
    await delay(1000);
  }
  throw new Error(`${name} did not become ready within 180 seconds`);
}

await mkdir(output, { recursive: true });
try {
  const metadata = JSON.parse(
    await docker(["image", "inspect", image, "--format", "{{json .}}"]),
  );
  assert.equal(metadata.Architecture, "amd64");
  assert.equal(metadata.Os, "linux");
  assert.equal(metadata.Config.User, "sourceweft");
  assert.ok(metadata.Config.Env.includes("NODE_ENV=production"));
  report.imageId = metadata.Id;
  const offline = [
    "run",
    "--rm",
    "--pull=never",
    "--network",
    "none",
    "-e",
    "COREPACK_ENABLE_NETWORK=0",
    image,
  ];
  report.pnpm = await docker([...offline, "pnpm", "--version"]);
  assert.equal(report.pnpm, "10.19.0");
  report.uid = Number(await docker([...offline, "id", "-u"]));
  assert.ok(
    Number.isInteger(report.uid) && report.uid > 0,
    "Image must run as non-root",
  );

  directory = await mkdtemp(join(tmpdir(), "sourceweft-ci-startup-"));
  const gatewayPath = join(directory, "gateway.json");
  const profile = {
    gatewaySlug: "ci-disabled",
    providerName: "ci-disabled",
    isDefault: true,
    isActive: true,
    pricing: { source: "manual", inputCostPerToken: 0, outputCostPerToken: 0 },
  };
  await writeFile(
    gatewayPath,
    JSON.stringify({
      gateways: [
        {
          slug: "ci-disabled",
          providerName: "ci-disabled",
          providerKind: "openai-compatible",
          baseUrl: "http://127.0.0.1:1/v1",
          activation: { env: "CI_MODELS_ENABLED", default: false },
          isDefault: true,
          supports: ["chat", "embeddings"],
          modelCatalog: { enabled: false },
        },
      ],
      chatProfiles: [
        {
          ...profile,
          profileAlias: "chat-default",
          modelAlias: "chat-default",
          targetModel: "ci-chat",
        },
      ],
      embeddingProfiles: [
        {
          ...profile,
          profileAlias: "embedding-default",
          modelAlias: "embedding-default",
          targetModel: "ci-embedding",
          requestedDimensions: 2,
          vectorStrategy: "exact",
        },
      ],
    }),
    { mode: 0o644 },
  );
  const envFile = join(directory, "container.env");
  const environment = {
    CI: "true",
    NODE_ENV: "production",
    DOTENV_CONFIG_PATH: "/tmp/sourceweft-ci-empty.env",
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    BETTER_AUTH_SECRET: authSecret,
    MODEL_GATEWAY_ENCRYPTION_SECRET: modelSecret,
    MODEL_GATEWAY_GLOBAL_CONFIG_PATH: "/ci/gateway.json",
    CI_MODELS_ENABLED: "false",
    SOURCEWEFT_SAAS_ENABLED: "false",
    SOURCEWEFT_SANDBOX_ENABLED: "false",
    MARKET_ENABLED: "false",
    MAIL_PROVIDER: "console",
    COREPACK_ENABLE_NETWORK: "0",
    BACKEND_API_HOST: "0.0.0.0",
    BACKEND_API_PORT: "3001",
    HOSTNAME: "0.0.0.0",
    PORT: "3000",
    NEXT_PUBLIC_API_BASE_URL: "http://localhost:3001",
    NEXT_PUBLIC_WEB_BASE_URL: "http://localhost:3000",
    BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3000,http://localhost:3001",
    MODEL_PRICING_SYNC_INTERVAL_MS: "3600000",
    MODEL_CATALOG_REFRESH_INTERVAL_MS: "3600000",
  };
  await writeFile(
    envFile,
    Object.entries(environment)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  // Native Linux host networking reaches only this runner's service ports.
  const common = [
    "--pull=never",
    "--network",
    "host",
    "--env-file",
    envFile,
    "-v",
    `${gatewayPath}:/ci/gateway.json:ro`,
  ];
  for (const kind of ["migrate", "api", "worker", "scheduler", "web"]) {
    const name = `${prefix}-${kind}`;
    const command =
      kind === "web"
        ? []
        : [
            "pnpm",
            "--filter",
            "@sourceweft/backend",
            kind === "migrate" ? "migrate" : `start:${kind}`,
          ];
    const stage = { kind, passed: false };
    report.stages.push(stage);
    containers.add(name);
    console.log(`Checking ${kind} in ${metadata.Id}`);
    if (kind === "migrate") {
      await docker(
        ["run", "--name", name, ...common, image, ...command],
        300_000,
      );
      stage.exitCode = (await state(name)).ExitCode;
      assert.equal(stage.exitCode, 0);
    } else {
      await docker([
        "run",
        "-d",
        "--name",
        name,
        ...common,
        ...(kind === "api" ? ["-e", "PORT=3001"] : []),
        image,
        ...command,
      ]);
      if (kind === "api" || kind === "web") {
        const url =
          kind === "api"
            ? "http://127.0.0.1:3001/v1/health"
            : "http://127.0.0.1:3000/";
        await waitFor(name, async () => {
          try {
            const response = await fetch(url, {
              signal: AbortSignal.timeout(3000),
              redirect: "manual",
            });
            stage.httpStatus = response.status;
            await response.arrayBuffer();
            return response.status === 200;
          } catch {
            return false;
          }
        });
      } else {
        const markers =
          kind === "worker"
            ? ["Primary worker started", "Deliverables worker started"]
            : ["Scheduler started"];
        await waitFor(name, async () => {
          const text = await logs(name);
          return markers.every((marker) => text.includes(marker));
        });
        await delay(3000);
        assert.equal((await state(name)).Running, true);
        assert.doesNotMatch(
          await logs(name),
          /Worker runtime error|Scheduler task failed|Unhandled|Fatal error/i,
        );
      }
      await docker(["stop", "-t", "20", name]);
      const stopped = await state(name);
      stage.exitCode = stopped.ExitCode;
      assert.equal(stopped.OOMKilled, false);
      assert.ok(
        (kind === "web" ? [0, 143] : [0]).includes(stopped.ExitCode),
        `${kind} exited with ${stopped.ExitCode}`,
      );
    }
    await recordLogs(name);
    await docker(["rm", name]);
    containers.delete(name);
    stage.passed = true;
  }
  report.passed = true;
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  const errors = [];
  for (const name of containers) {
    try {
      await recordLogs(name);
    } catch {
      errors.push(`${name}: log capture failed`);
    }
    try {
      await docker(["rm", "-f", name]);
    } catch {
      errors.push(`${name}: cleanup failed`);
    }
  }
  if (directory) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      errors.push("temporary configuration cleanup failed");
    }
  }
  report.cleanupErrors = errors;
  if (errors.length) {
    report.passed = false;
    process.exitCode = 1;
  }
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
