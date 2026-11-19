import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";
import { REQUIRED_TESTFLIGHT_SECRETS } from "./ios-build.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workflow = readFileSync(
  resolve(root, ".github/workflows/ios-build.yml"),
  "utf8",
);
const script = resolve(root, "scripts/ci/ios-build.mjs");

// Split the workflow into its top-level jobs so each can be checked alone.
const jobBlock = (name) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert(start >= 0, `job ${name} is missing`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

test("pull request and push jobs never reach Apple credentials or the environment", () => {
  const verify = jobBlock("verify");
  assert(
    !verify.includes("secrets."),
    "the verification job must not read secrets",
  );
  assert(
    !verify.includes("environment:"),
    "the verification job must not use an environment",
  );
  assert(
    !verify.includes("upload-testflight"),
    "the verification job must not upload",
  );
  assert(
    verify.includes("--target aarch64-sim"),
    "the verification build must target the simulator",
  );
});

test("only a manual testflight dispatch signs and uploads, from the gated environment", () => {
  const testflight = jobBlock("testflight");
  assert(
    testflight.includes(
      "github.event_name == 'workflow_dispatch' && inputs.mode == 'testflight'",
    ),
    "the TestFlight job must run only for a manual testflight dispatch",
  );
  assert(testflight.includes("environment: ios-testflight"));
  assert(testflight.includes("--export-method app-store-connect"));
  for (const name of [
    "IOS_CERTIFICATE",
    "IOS_CERTIFICATE_PASSWORD",
    "IOS_MOBILE_PROVISION",
  ]) {
    assert(
      testflight.includes(`${name}: `),
      `TestFlight job does not set the Tauri signing variable ${name}`,
    );
  }
  for (const name of REQUIRED_TESTFLIGHT_SECRETS) {
    assert(
      testflight.includes(`secrets.${name}`),
      `TestFlight job does not pass ${name}`,
    );
  }
  assert(
    testflight.indexOf("check-testflight-secrets") <
      testflight.indexOf("install-signing"),
    "secrets must be checked before signing",
  );
});

test("both jobs build with Xcode 26, which App Store Connect requires", () => {
  for (const name of ["verify", "testflight"]) {
    assert.match(
      jobBlock(name),
      /xcode-select -s \/Applications\/Xcode_26\.\d+\.app/,
      `${name} does not select Xcode 26`,
    );
  }
});

test("the workflow only calls subcommands the helper script defines", () => {
  const source = readFileSync(script, "utf8");
  for (const [, name] of workflow.matchAll(/ios-build\.mjs ([a-z-]+)/g)) {
    assert(
      source.includes(`"${name}"()`),
      `ios-build.mjs has no ${name} subcommand`,
    );
  }
});

test("a missing signing secret fails before any signing step and names the secret", () => {
  const env = { PATH: process.env.PATH };
  for (const name of REQUIRED_TESTFLIGHT_SECRETS) {
    assert.equal(env[name], undefined);
  }
  assert.throws(
    () =>
      execFileSync(process.execPath, [script, "check-testflight-secrets"], {
        env,
        stdio: "pipe",
      }),
    (error) => {
      const message = String(error.stderr);
      for (const name of REQUIRED_TESTFLIGHT_SECRETS)
        assert(message.includes(name), `${name} not reported`);
      return true;
    },
  );
});

test("a fully provided secret set passes the check", () => {
  const env = { PATH: process.env.PATH };
  for (const name of REQUIRED_TESTFLIGHT_SECRETS) env[name] = "x";
  execFileSync(process.execPath, [script, "check-testflight-secrets"], {
    env,
    stdio: "pipe",
  });
});
