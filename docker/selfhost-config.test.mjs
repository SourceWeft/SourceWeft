import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { runtimeEnvironment } from "./runtime-entrypoint.mjs";

test("DB fields are encoded once and do not diverge from the database password", () => {
  const password = "space @:/?#%中文";
  const env = runtimeEnvironment({
    DB_USER: "user@host",
    DB_PASSWORD: password,
    DB_NAME: "data/base",
  });
  const url = new URL(env.DATABASE_URL);
  assert.equal(decodeURIComponent(url.password), password);
  assert.equal(decodeURIComponent(url.username), "user@host");
  assert.equal(url.hostname, "postgres");
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "data/base");
});
test("explicit external connection overrides derived settings; utility commands require no database", () => {
  assert.equal(
    runtimeEnvironment({
      DATABASE_URL: "postgresql://external/database",
      DB_PASSWORD: "unused",
    }).DATABASE_URL,
    "postgresql://external/database",
  );
  assert.deepEqual(runtimeEnvironment({}), {});
  assert.throws(() => runtimeEnvironment({ DB_USER: "user" }), /DB_PASSWORD/);
});
test("README initializer generates independent secrets and never overwrites an existing installation", () => {
  const dir = mkdtempSync(join(tmpdir(), "sourceweft-init-test-"));
  try {
    writeFileSync(
      join(dir, ".env.example"),
      readFileSync(new URL("./.env.example", import.meta.url)),
    );
    execFileSync(process.execPath, [resolve("docker/init-config.mjs"), dir], {
      env: { ...process.env, SOURCEWEFT_IMAGE: "sourceweft:test" },
    });
    const text = readFileSync(join(dir, ".env"), "utf8");
    const values = [
      "DB_PASSWORD",
      "S3_SECRET_ACCESS_KEY",
      "BETTER_AUTH_SECRET",
      "MODEL_GATEWAY_ENCRYPTION_SECRET",
    ].map((key) => new RegExp(`^${key}=([a-f0-9]{64})$`, "m").exec(text)?.[1]);
    assert.equal(values.filter(Boolean).length, 4);
    assert.equal(new Set(values).size, 4);
    assert.match(text, /SOURCEWEFT_IMAGE=sourceweft:test/);
    assert.throws(() =>
      execFileSync(process.execPath, [resolve("docker/init-config.mjs"), dir], {
        stdio: "pipe",
      }),
    );
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), text);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("template markers fail before a service can start with shared placeholder secrets", () => {
  assert.throws(
    () => runtimeEnvironment({ BETTER_AUTH_SECRET: "GENERATED_BY_INIT" }),
    /Initialize/,
  );
  assert.throws(
    () => runtimeEnvironment({ PUBLIC_WEB_BASE_URL: "javascript:alert(1)" }),
    /HTTP/,
  );
});

test("shipped Compose derives the public port, wires private storage and isolates projects", () => {
  const dir = mkdtempSync(join(tmpdir(), "sourceweft-compose-contract-"));
  try {
    for (const name of [".env.example", "docker-compose.yml", "nginx.conf"])
      writeFileSync(
        join(dir, name),
        readFileSync(new URL(`./${name}`, import.meta.url)),
      );
    execFileSync(process.execPath, [resolve("docker/init-config.mjs"), dir], {
      stdio: "pipe",
    });
    let text = readFileSync(join(dir, ".env"), "utf8").replace(
      /^WEB_PORT=.*$/m,
      "WEB_PORT=43127",
    );
    writeFileSync(join(dir, ".env"), text);
    const env = { ...process.env };
    for (const line of text.split("\n")) {
      const m = /^([A-Z_0-9]+)=/.exec(line);
      if (m) delete env[m[1]];
    }
    delete env.COMPOSE_FILE;
    delete env.COMPOSE_PROJECT_NAME;
    const config = (project) =>
      JSON.parse(
        execFileSync(
          "docker",
          [
            "compose",
            "--env-file",
            join(dir, ".env"),
            "-f",
            join(dir, "docker-compose.yml"),
            "-p",
            project,
            "config",
            "--format",
            "json",
          ],
          { env, encoding: "utf8" },
        ),
      );
    const a = config("selfhost-contract-a"),
      b = config("selfhost-contract-b");
    assert.equal(
      a.services.api.environment.PUBLIC_API_BASE_URL,
      "http://localhost:43127",
    );
    assert.equal(
      a.services.web.environment.INTERNAL_API_BASE_URL,
      "http://api:3001",
    );
    assert.equal(a.services.api.environment.DATABASE_URL, "");
    assert.equal(
      a.services.api.environment.S3_SECRET_ACCESS_KEY,
      a.services.storage.environment.AWS_SECRET_ACCESS_KEY,
    );
    assert.equal(
      a.services.api.depends_on["storage-init"].condition,
      "service_completed_successfully",
    );
    for (const service of ["api", "web", "postgres", "redis", "storage"])
      assert.equal(a.services[service].ports, undefined);
    assert.notEqual(a.volumes.postgres_data.name, b.volumes.postgres_data.name);
    assert.notEqual(a.volumes.storage_data.name, b.volumes.storage_data.name);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("PostgreSQL publication and consumers use the public owner-scoped package", () => {
  const expected = "ghcr.io/sourceweft/sourceweft-postgres:17";
  const compose = readFileSync(
    new URL("./docker-compose.yml", import.meta.url),
    "utf8",
  );
  assert.ok(compose.includes(`SOURCEWEFT_POSTGRES_IMAGE:-${expected}`));
  for (const file of ["ci.yml", "billing-editions.yml", "release.yml"]) {
    const workflow = readFileSync(
      new URL(`../.github/workflows/${file}`, import.meta.url),
      "utf8",
    );
    assert.ok(
      workflow.includes(expected),
      `${file} must use the published package`,
    );
    assert.ok(
      !workflow.includes("ghcr.io/sourceweft/sourceweft/sourceweft-postgres"),
    );
  }
  const publisher = readFileSync(
    new URL(
      "../.github/workflows/sourceweft-postgres-image.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(
    (
      publisher.match(
        /\$\{GITHUB_REPOSITORY_OWNER,,\}\/sourceweft-postgres/g,
      ) ?? []
    ).length,
    2,
  );
  assert.ok(!publisher.includes("${GITHUB_REPOSITORY,,}/sourceweft-postgres"));
});
