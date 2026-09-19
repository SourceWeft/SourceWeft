import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const run = promisify(execFile);
const root = process.cwd();
const image = process.argv[2];
if (!image) throw new Error("Pass the locally built image");
const project = `sourceweft-selfhost-${randomUUID().slice(0, 8)}`;
const dir = await mkdtemp(join(tmpdir(), project));
const output = resolve("output/ci/selfhost");
await mkdir(output, { recursive: true });
let secrets = [];
let passed = false;
let configured = false;
let failure;
const redact = (text) =>
  secrets.reduce(
    (value, secret) => value.replaceAll(secret, "<redacted>"),
    String(text),
  );
const execute = async (command, args, options = {}) => {
  try {
    return await run(command, args, {
      cwd: root,
      timeout: 600000,
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    throw new Error(
      redact(`${command} failed: ${error.stdout ?? ""}\n${error.stderr ?? ""}`),
    );
  }
};
const port = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const env = { ...process.env };
// Host shell settings outrank --env-file during Compose interpolation. Remove
// every shipped setting so the fresh install cannot inherit developer services.
const composeTemplate = await readFile(
  join(root, "docker/docker-compose.yml"),
  "utf8",
);
const envTemplate = await readFile(join(root, "docker/.env.example"), "utf8");
for (const match of composeTemplate.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g))
  delete env[match[1]];
for (const match of envTemplate.matchAll(/^([A-Z][A-Z0-9_]*)=/gm))
  delete env[match[1]];
for (const key of Object.keys(env))
  if (
    /^(COMPOSE_|DB_|DATABASE_URL|REDIS_URL|S3_|AWS_|PUBLIC_|NEXT_PUBLIC_|SOURCEWEFT_|BETTER_AUTH_|MODEL_GATEWAY_)/.test(
      key,
    )
  )
    delete env[key];
const composeArgs = [
  "compose",
  "--env-file",
  join(dir, ".env"),
  "-p",
  project,
  "-f",
  join(dir, "docker-compose.yml"),
  "-f",
  join(dir, "test.yml"),
];
const compose = (args) => execute("docker", [...composeArgs, ...args], { env });
try {
  for (const file of ["docker-compose.yml", ".env.example", "nginx.conf"])
    await cp(join(root, "docker", file), join(dir, file));
  await cp(join(root, "scripts/ci/selfhost-fixtures"), join(dir, "fixtures"), {
    recursive: true,
  });
  console.log(`Selfhost ${project}: initializing shipped configuration`);
  await execute("docker", [
    "run",
    "--rm",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--entrypoint",
    "node",
    "-e",
    `SOURCEWEFT_IMAGE=${image}`,
    "-v",
    `${dir}:/config`,
    image,
    "/app/docker/init-config.mjs",
    "/config",
  ]);
  let configuration = await readFile(join(dir, ".env"), "utf8");
  secrets = configuration
    .split("\n")
    .filter((line) =>
      /^(DB_PASSWORD|S3_SECRET_ACCESS_KEY|BETTER_AUTH_SECRET|MODEL_GATEWAY_ENCRYPTION_SECRET)=/.test(
        line,
      ),
    )
    .map((line) => line.slice(line.indexOf("=") + 1));
  // Only the model provider is a fixture. All infrastructure, auth and storage are real.
  await writeFile(
    join(dir, "test.yml"),
    `services:\n  model-fixture:\n    image: ${image}\n    command: ["node", "/fixtures/model.mjs"]\n    volumes: ["./fixtures:/fixtures:ro"]\n`,
  );
  configuration +=
    "\nMODEL_GATEWAY_GLOBAL_CONFIG_PATH=/fixtures/gateway.json\nSELFHOST_MODEL_ENABLED=true\nSELFHOST_MODEL_KEY=test-only\nOPENROUTER_ENABLED=false\nORCAROUTER_ENABLED=false\n";
  let override = await readFile(join(dir, "test.yml"), "utf8");
  for (const service of ["api", "worker", "scheduler", "migrate"])
    override += `  ${service}:\n    volumes: ["./fixtures:/fixtures:ro"]\n`;
  await writeFile(join(dir, "test.yml"), override);
  for (const phase of ["first", "restart"]) {
    const p = await port();
    const base = `http://${phase === "first" ? "localhost" : "127.0.0.1"}:${p}`;
    await writeFile(
      join(dir, ".env"),
      configuration
        .replace(/^WEB_PORT=.*$/m, `WEB_PORT=${p}`)
        .replace(
          /^PUBLIC_WEB_BASE_URL=.*$/m,
          `PUBLIC_WEB_BASE_URL=${phase === "first" ? "" : base}`,
        ),
      { mode: 0o600 },
    );
    configured = true;
    console.log(`Selfhost ${project}: ${phase} startup on ${base}`);
    await compose(["up", "-d", "--wait", "--wait-timeout", "300"]);
    console.log(
      `Selfhost ${project}: services ready, running ${phase} browser checks`,
    );
    const result = await execute(
      "pnpm",
      ["exec", "playwright", "test", "--config", "e2e/selfhost.config.ts"],
      {
        cwd: join(root, "apps/web"),
        env: {
          ...env,
          SELFHOST_BASE_URL: base,
          SELFHOST_STATE_FILE: join(dir, "browser.private.json"),
          SELFHOST_PHASE: phase,
        },
      },
    );
    console.log(redact(result.stdout));
    // Same volumes, new port: checks both persistence and runtime address portability.
    const logs = await compose(["logs", "--no-color"]);
    await writeFile(
      join(output, `${phase}.log`),
      redact(logs.stdout + logs.stderr),
    );
    assert.doesNotMatch(
      logs.stdout + logs.stderr,
      /Dynamic require of|Failed to load capability entry module|deliverable_pipeline_builtin_fallback_load_failed/,
      "Production capability modules must load successfully",
    );
    await compose(["down", "--remove-orphans"]);
  }
  passed = true;
} catch (error) {
  failure = redact(error.message);
  process.exitCode = 1;
  console.error(failure);
} finally {
  try {
    const logs = await compose(["logs", "--no-color"]);
    await writeFile(
      join(output, "compose.log"),
      redact(logs.stdout + logs.stderr),
    );
  } catch {}
  if (configured) {
    try {
      const ids = (await compose(["ps", "-a", "-q"])).stdout
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const id of ids) {
        const state = await execute("docker", [
          "inspect",
          id,
          "--format",
          "{{json .State}}",
        ]);
        await writeFile(
          join(output, `${project}-${id.slice(0, 12)}.state.json`),
          redact(state.stdout),
        );
      }
    } catch (error) {
      console.error(`Could not capture container state: ${error.message}`);
    }
  }
  // The randomly generated project is the only deletion target; no fixed user volumes.
  if (configured)
    try {
      await compose(["down", "--volumes", "--remove-orphans"]);
    } catch (error) {
      failure = `${failure ?? ""} Cleanup: ${error.message}`;
      process.exitCode = 1;
      passed = false;
    }
  await writeFile(
    join(output, "result.json"),
    JSON.stringify({ project, image, passed, failure }, null, 2),
  );
  await rm(dir, { recursive: true, force: true });
}
