import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { EnabledSkillDescriptor } from "../../skills/types";
import { buildSandboxSkillStageFiles } from "./skill-staging";

function skill(overrides: Partial<EnabledSkillDescriptor> = {}): EnabledSkillDescriptor {
  return {
    workspaceSkillId: "workspace_skill_test",
    sourceType: "builtin",
    name: "tool-a",
    version: "1.0.0",
    description: "Tool A",
    files: [
      {
        path: "skill.json",
        contentText: "{}",
        mimeType: "application/json",
        sizeBytes: 2,
        contentHash: "hash_json",
      },
      {
        path: "scripts/run.js",
        contentText: "console.log('ok')",
        mimeType: "text/javascript",
        sizeBytes: 17,
        contentHash: "hash_script",
      },
    ],
    ...overrides,
  };
}

describe("buildSandboxSkillStageFiles", () => {
  test("maps enabled skill bundle files under /skills/<skill-name>", () => {
    const files = buildSandboxSkillStageFiles({ enabledSkills: [skill()] });

    assert.deepEqual(
      files.map((file) => ({
        skillName: file.skillName,
        sourcePath: file.sourcePath,
        sandboxPath: file.sandboxPath,
        sizeBytes: file.sizeBytes,
      })),
      [
        {
          skillName: "tool-a",
          sourcePath: "skill.json",
          sandboxPath: "/skills/tool-a/skill.json",
          sizeBytes: 2,
        },
        {
          skillName: "tool-a",
          sourcePath: "scripts/run.js",
          sandboxPath: "/skills/tool-a/scripts/run.js",
          sizeBytes: 17,
        },
      ],
    );
    assert.equal(new TextDecoder().decode(files[1]!.content), "console.log('ok')");
  });

  test("rejects unsafe skill names", () => {
    assert.throws(
      () => buildSandboxSkillStageFiles({ enabledSkills: [skill({ name: "../evil" })] }),
      /SANDBOX_SKILL_STAGE_PATH_DENIED/,
    );
  });

  test("rejects absolute or traversing bundle paths", () => {
    for (const path of ["/abs.js", "../evil.js", "nested/../../evil.js", "~/secret"]) {
      assert.throws(
        () => buildSandboxSkillStageFiles({
          enabledSkills: [skill({ files: [{
            path,
            contentText: "x",
            mimeType: "text/plain",
            sizeBytes: 1,
            contentHash: "hash",
          }] })],
        }),
        /SANDBOX_SKILL_STAGE_PATH_DENIED/,
      );
    }
  });

  test("enforces file and total byte limits", () => {
    assert.throws(
      () => buildSandboxSkillStageFiles({
        enabledSkills: [skill({ files: [{
          path: "big.txt",
          contentText: "abc",
          mimeType: "text/plain",
          sizeBytes: 3,
          contentHash: "hash",
        }] })],
        maxFileBytes: 2,
      }),
      /SANDBOX_SKILL_STAGE_FILE_TOO_LARGE/,
    );

    assert.throws(
      () => buildSandboxSkillStageFiles({
        enabledSkills: [skill()],
        maxTotalBytes: 3,
      }),
      /SANDBOX_SKILL_STAGE_TOTAL_SIZE_EXCEEDED/,
    );
  });
});
