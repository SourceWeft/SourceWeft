import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  desktopPublicationPolicy,
  updatePublicationPolicy,
  distributionClaims,
} from "./desktop-publication-policy.mjs";

test("modes are explicit and absent credentials cannot downgrade the default", () => {
  assert.equal(desktopPublicationPolicy(), "signed");
  assert.equal(updatePublicationPolicy(), "signed");
  for (const value of ["", "auto", "unsigned", null, false])
    assert.throws(() => desktopPublicationPolicy(value));
  assert.throws(() => updatePublicationPolicy("candidate"));
  for (const platform of ["macos", "windows", "linux"]) {
    assert.deepEqual(distributionClaims("updater-signed", platform), {
      distributionSigned: false,
      notarized: false,
    });
    assert.equal(
      distributionClaims("signed", platform).distributionSigned,
      platform !== "linux",
    );
  }
});

test("workflow passes explicit policy, withholds platform secrets, and keeps updater keys mandatory", async () => {
  const require = createRequire(
    new URL("../../apps/backend/package.json", import.meta.url),
  );
  const { parse } = require("yaml");
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/desktop-release.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    workflow.on.workflow_call.inputs.publication_policy.default,
    "signed",
  );
  assert.deepEqual(
    workflow.on.workflow_dispatch.inputs.publication_policy.options,
    ["signed", "updater-signed"],
  );
  const build = workflow.jobs.build;
  assert.equal(build.env.SOURCEWEFT_SIGNED_RELEASE, "true");
  assert.equal(
    build.env.TAURI_SIGNING_PRIVATE_KEY,
    "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
  );
  for (const key of [
    "APPLE_CERTIFICATE",
    "APPLE_ID",
    "APPLE_SIGNING_IDENTITY",
    "WINDOWS_TIMESTAMP_URL",
  ])
    assert.match(build.env[key], /publication_policy == 'signed'/);
  assert.match(
    build.steps.find((s) => s.name === "Import Windows signing certificate").if,
    /publication_policy == 'signed'/,
  );
  const command = build.steps.find(
    (s) => s.name === "Build installers with required updater signatures",
  ).run;
  assert.doesNotMatch(command, /--no-sign/);
  assert.match(command, /unset APPLE_CERTIFICATE/);
  assert.equal(build.strategy.matrix.include.length, 4);
  const release = parse(
    await readFile(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    release.jobs.desktop.with.publication_policy,
    "${{ needs.preflight.outputs.desktop_policy }}",
  );
  const draft = release.jobs.release.steps.find(
    (s) => s.id === "github_release",
  );
  assert.match(draft.if, /updater-signed/);
  assert.match(
    draft.with.body,
    /no Apple Developer ID or Windows publisher certificate/,
  );
  assert.match(
    release.jobs.release.env.DESKTOP_PUBLICATION_POLICY,
    /desktop_policy/,
  );
});
