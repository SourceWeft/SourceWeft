import assert from "node:assert/strict";
import { test } from "vitest";
import { buildSkillSandboxAssetPlans } from "./sandbox-assets";
import type { EnabledSkillDescriptor } from "./types";
import type { SkillBundleFile } from "./builtin";

function bundleFile(
  path: string,
  contentText: string,
  overrides: Partial<SkillBundleFile> = {},
): SkillBundleFile {
  return {
    path,
    contentText,
    mimeType: "text/markdown",
    sizeBytes: Buffer.byteLength(contentText, "utf8"),
    contentHash: `hash:${path}:${contentText.length}`,
    ...overrides,
  };
}

function skill(
  overrides: Partial<EnabledSkillDescriptor> = {},
): EnabledSkillDescriptor {
  return {
    workspaceSkillId: "ws-skill-1",
    sourceType: "builtin",
    name: "ppt-deck",
    version: "1.2.0",
    description: "Deck builder",
    files: [
      bundleFile("SKILL.md", "# ppt-deck"),
      bundleFile("scripts/validate_pptx.py", "print('ok')"),
    ],
    ...overrides,
  } as EnabledSkillDescriptor;
}

test("builds a deterministic plan targeting the /skills contract path", () => {
  const [plan] = buildSkillSandboxAssetPlans([skill()]);
  assert.ok(plan);
  assert.equal(plan.name, "ppt-deck");
  assert.equal(plan.version, "1.2.0");
  assert.equal(plan.installDir, "/skills/ppt-deck");
  assert.equal(plan.entrypoint, "SKILL.md");
  assert.equal(plan.archive, "zip");
  assert.match(plan.sha256, /^[a-f0-9]{64}$/u);

  // Same content → same digest (cache aside, the zip is deterministic).
  const [again] = buildSkillSandboxAssetPlans([skill()]);
  assert.equal(again?.sha256, plan.sha256);

  // Different content → different digest.
  const [changed] = buildSkillSandboxAssetPlans([
    skill({
      files: [
        bundleFile("SKILL.md", "# ppt-deck v2"),
        bundleFile("scripts/validate_pptx.py", "print('ok')"),
      ],
    }),
  ]);
  assert.notEqual(changed?.sha256, plan.sha256);
});

test("loadContent returns a zip whose bytes hash to the plan sha", async () => {
  const { createHash } = await import("node:crypto");
  const [plan] = buildSkillSandboxAssetPlans([skill()]);
  const content = await plan!.loadContent!();
  assert.ok(content && content.byteLength > 0);
  assert.equal(
    createHash("sha256").update(content!).digest("hex"),
    plan!.sha256,
  );
  // Zip magic: PK\x03\x04.
  assert.equal(content![0], 0x50);
  assert.equal(content![1], 0x4b);
});

test("normalizes unsafe version strings without losing content authority", () => {
  const [plan] = buildSkillSandboxAssetPlans([skill({ version: "2.0 β/beta" })]);
  assert.ok(plan);
  assert.match(plan.version, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);
});

test("skips ineligible skills instead of failing the batch", () => {
  const warnings: string[] = [];
  const logger = {
    warn: (_message: string, meta?: Record<string, unknown>) => {
      warnings.push(String(meta?.reason ?? ""));
    },
  };
  const plans = buildSkillSandboxAssetPlans(
    [
      skill({ name: "../evil" }),
      skill({
        name: "no-skill-md",
        files: [bundleFile("README.md", "no entry")],
      }),
      skill({
        name: "traversal",
        files: [
          bundleFile("SKILL.md", "# x"),
          bundleFile("../outside.txt", "escape"),
        ],
      }),
      skill({
        name: "too-big",
        files: [
          bundleFile("SKILL.md", "# x"),
          bundleFile("blob.txt", "x", { sizeBytes: 5 * 1024 * 1024 }),
        ],
      }),
      skill({ name: "empty-bundle", files: [] }),
      skill(),
    ],
    logger,
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.name, "ppt-deck");
  assert.deepEqual(warnings.sort(), [
    "bundle_too_large",
    "missing_skill_md",
    "unsafe_file_path",
    "unsafe_name",
  ]);
});
