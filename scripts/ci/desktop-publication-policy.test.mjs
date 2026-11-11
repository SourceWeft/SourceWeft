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

test("macos-signed is explicit and claims Developer ID signing and notarization for macOS only", () => {
  assert.equal(desktopPublicationPolicy("macos-signed"), "macos-signed");
  assert.equal(updatePublicationPolicy("macos-signed"), "macos-signed");
  assert.deepEqual(distributionClaims("macos-signed", "macos"), {
    distributionSigned: true,
    notarized: true,
  });
  for (const platform of ["windows", "linux"])
    assert.deepEqual(distributionClaims("macos-signed", platform), {
      distributionSigned: false,
      notarized: false,
    });
  // Only macOS is ever notarized, in any mode.
  assert.equal(distributionClaims("signed", "macos").notarized, true);
  assert.equal(distributionClaims("signed", "windows").notarized, false);
  for (const value of ["macOS-signed", "mac-signed", "apple-signed"])
    assert.throws(() => desktopPublicationPolicy(value));
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
    ["signed", "macos-signed", "updater-signed"],
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
  // macos-signed hands the Apple credentials to the macOS legs only, and never any Windows
  // signing input.
  for (const key of [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  ])
    assert(
      build.env[key].includes(
        "(inputs.publication_policy == 'macos-signed' && endsWith(matrix.target, '-apple-darwin'))",
      ),
      key,
    );
  assert.doesNotMatch(build.env.WINDOWS_TIMESTAMP_URL, /macos-signed/);
  const windowsImport = build.steps.find(
    (s) => s.name === "Import Windows signing certificate",
  ).if;
  assert.match(windowsImport, /publication_policy == 'signed'/);
  assert.doesNotMatch(windowsImport, /macos-signed/);
  for (const job of Object.values(workflow.jobs))
    assert.doesNotMatch(
      JSON.stringify(
        job.steps.filter((s) => /Windows/.test(s.name ?? "")).map((s) => s.if),
      ),
      /macos-signed/,
    );
  const command = build.steps.find(
    (s) => s.name === "Build installers with required updater signatures",
  ).run;
  assert.doesNotMatch(command, /--no-sign/);
  assert.match(command, /unset APPLE_CERTIFICATE/);
  // Under macos-signed only the non-macOS legs drop the Apple credentials.
  assert.match(
    command,
    /"macos-signed" \]; then[\s\S]*\*-apple-darwin\) ;;\s*\*\) unset APPLE_CERTIFICATE /,
  );
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
  assert.match(draft.if, /macos-signed/);
  assert.match(
    draft.with.body,
    /desktop_policy == 'macos-signed' && 'macOS installers are Developer ID signed and notarized\. Windows installers have no publisher certificate/,
  );
  const recovery = parse(
    await readFile(
      new URL(
        "../../.github/workflows/desktop-release-recovery.yml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.match(
    JSON.stringify(recovery),
    /policy == 'macos-signed' && 'macOS installers are Developer ID signed and notarized\. Windows installers have no publisher certificate/,
  );
  assert.match(
    draft.with.body,
    /no Apple Developer ID or Windows publisher certificate/,
  );
  assert.match(
    release.jobs.release.env.DESKTOP_PUBLICATION_POLICY,
    /desktop_policy/,
  );
});
