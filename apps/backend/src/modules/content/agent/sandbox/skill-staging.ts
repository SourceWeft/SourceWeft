import { config } from "../../../../shared/config";
import type { EnabledSkillDescriptor } from "../../skills/types";
import { dirname } from "./paths";
import { SANDBOX_SKILLS_ROOT } from "./types";

export type SandboxStagedSkillFile = {
  skillName: string;
  sourcePath: string;
  sandboxPath: string;
  sizeBytes: number;
  content: Uint8Array;
};

function hasControlChars(value: string) {
  return /[\x00-\x1f\x7f]/.test(value);
}

function assertSandboxSkillName(value: string) {
  const name = value.trim();
  if (
    hasControlChars(name) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) ||
    name.includes("--")
  ) {
    throw new Error(
      "SANDBOX_SKILL_STAGE_PATH_DENIED: skill name must be a safe slug.",
    );
  }
  return name;
}

function assertRelativeSkillFilePath(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (
    hasControlChars(normalized) ||
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    normalized.includes("/~") ||
    parts.length === 0 ||
    parts.some((part) => part === "." || part === ".." || part.includes("\x00"))
  ) {
    throw new Error(
      "SANDBOX_SKILL_STAGE_PATH_DENIED: skill bundle file paths must be relative and stay inside the skill root.",
    );
  }
  return parts.join("/");
}

export function buildSandboxSkillStageFiles(input: {
  enabledSkills: EnabledSkillDescriptor[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
}): SandboxStagedSkillFile[] {
  const maxFileBytes = input.maxFileBytes ?? config.sandbox.maxPrepareFileBytes;
  const maxTotalBytes = input.maxTotalBytes ?? config.sandbox.maxPrepareTotalBytes;
  const encoder = new TextEncoder();
  const staged: SandboxStagedSkillFile[] = [];
  let totalBytes = 0;

  for (const skill of input.enabledSkills) {
    const skillName = assertSandboxSkillName(skill.name);
    for (const file of skill.files) {
      const sourcePath = assertRelativeSkillFilePath(file.path);
      const content = encoder.encode(file.contentText);
      const sizeBytes = content.byteLength;
      if (sizeBytes > maxFileBytes) {
        throw new Error(
          `SANDBOX_SKILL_STAGE_FILE_TOO_LARGE: ${skillName}/${sourcePath} exceeds skill staging file limit.`,
        );
      }
      totalBytes += sizeBytes;
      if (totalBytes > maxTotalBytes) {
        throw new Error(
          "SANDBOX_SKILL_STAGE_TOTAL_SIZE_EXCEEDED: enabled skill files exceed total staging limit.",
        );
      }
      staged.push({
        skillName,
        sourcePath,
        sandboxPath: `${SANDBOX_SKILLS_ROOT}/${skillName}/${sourcePath}`,
        sizeBytes,
        content,
      });
    }
  }

  return staged;
}

export async function uploadSandboxSkillStageFiles(input: {
  providerSandboxId: string;
  files: SandboxStagedSkillFile[];
  adapter: {
    ensureDirectory(input: { providerSandboxId: string; directory: string }): Promise<unknown>;
    uploadFile(input: { providerSandboxId: string; sandboxPath: string; content: Uint8Array }): Promise<unknown>;
  };
}) {
  for (const file of input.files) {
    await input.adapter.ensureDirectory({
      providerSandboxId: input.providerSandboxId,
      directory: dirname(file.sandboxPath),
    });
    await input.adapter.uploadFile({
      providerSandboxId: input.providerSandboxId,
      sandboxPath: file.sandboxPath,
      content: file.content,
    });
  }
}
