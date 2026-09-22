import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(
  new URL("../../apps/backend/package.json", import.meta.url),
);
const { parse } = require("yaml");
const workflow = parse(
  readFileSync(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  ),
);

test("every quality and publication checkout uses the one resolved commit", () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === "revision") continue;
    assert.ok([job.needs].flat().includes("revision"), name);
    const checkout = job.steps.find(
      (step) => step.uses === "actions/checkout@v4",
    );
    assert.equal(checkout.with.ref, "${{ needs.revision.outputs.sha }}", name);
  }
});

test("publication is manual-only, gated by all checks, and scoped to commit tags", () => {
  assert.equal(workflow.on.push, undefined);
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
  assert.ok(Object.hasOwn(workflow.on, "workflow_call"));
  assert.equal(workflow.on.workflow_dispatch.inputs.commit.required, true);
  assert.equal(workflow.permissions.packages, "read");
  const publish = workflow.jobs["docker-image"];
  assert.equal(
    publish.if,
    "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
  );
  assert.equal(publish.permissions.packages, "write");
  assert.deepEqual(
    new Set(publish.needs),
    new Set(
      Object.keys(workflow.jobs).filter((name) => name !== "docker-image"),
    ),
  );
  assert.equal(publish.concurrency["cancel-in-progress"], false);
  const build = publish.steps.find((step) => step.id === "build");
  assert.equal(build.if, "steps.existing.outputs.exists == 'false'");
  assert.equal(build.with.platforms, "linux/amd64,linux/arm64");
  assert.equal(build.with.push, true);
  assert.match(
    build.with["build-args"],
    /BUILD_SHA=\$\{\{ needs.revision.outputs.sha \}\}/,
  );
  assert.equal(
    build.with.tags,
    "${{ steps.metadata.outputs.image }}:${{ steps.metadata.outputs.tag }}",
  );
  assert.match(
    publish.steps.find((step) => step.id === "metadata").run,
    /tag=sha-\$SOURCE_SHA/,
  );
  assert.equal(
    workflow.jobs["docker-build"].steps.find(
      (step) => step.uses === "docker/build-push-action@v6",
    ).with.push,
    false,
  );
});

test("the release caller permits CI's declared ceiling while quality jobs remain read-only", () => {
  const release = parse(
    readFileSync(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(release.jobs.quality.permissions.packages, "write");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== "docker-image")
      assert.notEqual(job.permissions?.packages, "write", name);
  }
});

test("revision resolver pins short SHAs and rejects unknown, unmerged, and unsafe inputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "sourceweft-image-revision-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "CI Test",
    GIT_AUTHOR_EMAIL: "ci@example.invalid",
    GIT_COMMITTER_NAME: "CI Test",
    GIT_COMMITTER_EMAIL: "ci@example.invalid",
  };
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "-b", "main");
    git("commit", "--allow-empty", "-m", "initial");
    const first = git("rev-parse", "HEAD");
    git("commit", "--allow-empty", "-m", "main change");
    const main = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", main);
    git("checkout", "-b", "unmerged", first);
    git("commit", "--allow-empty", "-m", "unmerged change");
    const unmerged = git("rev-parse", "HEAD");
    git("checkout", "main");
    const output = join(dir, "output");
    const summary = join(dir, "summary");
    const script = workflow.jobs.revision.steps.find(
      (step) => step.id === "resolve",
    ).run;
    const run = (
      input,
      event = "workflow_dispatch",
      ref = "refs/heads/main",
    ) => {
      writeFileSync(output, "");
      return spawnSync("bash", ["-c", script], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...env,
          SELECTED_COMMIT: input,
          GITHUB_EVENT_NAME: event,
          GITHUB_REF: ref,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
      });
    };
    assert.equal(run(first.slice(0, 8)).status, 0);
    assert.equal(readFileSync(output, "utf8").trim(), `sha=${first}`);
    assert.equal(run(main).status, 0);
    for (const input of [
      "main",
      "",
      "abc",
      "$(touch injected)",
      "0".repeat(40),
      unmerged,
    ]) {
      assert.notEqual(run(input).status, 0, input);
    }
    assert.notEqual(
      run(first, "workflow_dispatch", "refs/heads/unmerged").status,
      0,
    );
    for (const event of ["push", "pull_request", "workflow_call"]) {
      assert.equal(run("", event, "refs/pull/1/merge").status, 0);
      assert.equal(readFileSync(output, "utf8").trim(), `sha=${main}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry lookup distinguishes an absent tag from authentication and network failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "sourceweft-image-registry-"));
  try {
    const docker = join(dir, "docker");
    writeFileSync(
      docker,
      '#!/bin/bash\nprintf "%s\\n" "$MOCK_STDOUT"\nprintf "%s\\n" "$MOCK_STDERR" >&2\nexit "$MOCK_STATUS"\n',
    );
    chmodSync(docker, 0o755);
    const output = join(dir, "output");
    const script = workflow.jobs["docker-image"].steps.find(
      (step) => step.id === "existing",
    ).run;
    const digest = `sha256:${"a".repeat(64)}`;
    const run = (status, stdout = "", stderr = "") => {
      writeFileSync(output, "");
      return spawnSync("bash", ["-c", script], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          IMAGE: "ghcr.io/example/image",
          TAG: "sha-test",
          GITHUB_OUTPUT: output,
          MOCK_STATUS: String(status),
          MOCK_STDOUT: stdout,
          MOCK_STDERR: stderr,
        },
      });
    };
    assert.equal(run(0, JSON.stringify({ digest })).status, 0);
    assert.match(readFileSync(output, "utf8"), /exists=true/);
    assert.equal(
      run(1, "", "ERROR: ghcr.io/example/image:sha-test: not found").status,
      0,
    );
    assert.equal(readFileSync(output, "utf8").trim(), "exists=false");
    for (const error of [
      "ERROR: unauthorized",
      "ERROR: TLS handshake timeout",
      "ERROR: credentials not found",
      "ERROR: another/image:sha-test: not found",
    ]) {
      assert.notEqual(run(1, "", error).status, 0, error);
      assert.equal(readFileSync(output, "utf8"), "");
    }
    assert.notEqual(run(0, JSON.stringify({ digest: "invalid" })).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
