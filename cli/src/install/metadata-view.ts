import { stringifySkillMetadata } from "@sourceweft/skill-format";
import {
  isAgentSkillName,
  parseSkillFrontmatter,
  sha256,
  skillMetadataSource,
} from "@sourceweft/skill-format";
import type { VerifiedFile } from "./verify";

export const INSTALL_FORMAT_VERSION = 1;
/** Verification precedes this adapter; only local loader metadata changes. */
export function prepareInstalledFiles(
  files: readonly VerifiedFile[],
  name: string,
  description: string,
): {
  files: VerifiedFile[];
  sourceFiles?: Record<string, string>;
  originalSkillMd?: string;
} {
  const skill = files.find((file) => file.path === "SKILL.md");
  if (!skill || !isAgentSkillName(name))
    throw new Error(
      "A safe skill name and SKILL.md are required for installation",
    );
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(skill.bytes);
  const source = skillMetadataSource(raw);
  const metadata = parseSkillFrontmatter(source);
  if (
    metadata &&
    (typeof metadata.name !== "string" ||
      !metadata.name.trim() ||
      typeof metadata.description !== "string" ||
      !metadata.description.trim())
  )
    throw new Error("Explicit skill metadata is incomplete");
  if (
    metadata &&
    metadata.name === name &&
    (metadata.description as string).length <= 1024 &&
    source === raw
  )
    return { files: [...files] };
  if (!description.trim() || description.length > 1024)
    throw new Error(
      "Catalog metadata cannot produce a compatible skill description",
    );
  let body = raw;
  if (metadata) {
    const opening = /^\uFEFF?---[ \t]*(?:\r?\n|$)/.exec(source)!;
    const closing = /^---[ \t]*(?:\r?$)/m.exec(
      source.slice(opening[0].length),
    )!;
    body =
      raw.slice(0, raw.length - source.length) +
      source
        .slice(opening[0].length + closing.index + closing[0].length)
        .replace(/^\r?\n/, "");
  }
  const fields = {
    ...(metadata ?? {}),
    name,
    description:
      metadata && (metadata.description as string).length <= 1024
        ? metadata.description
        : description,
  };
  const content = `---\n${stringifySkillMetadata(fields)}---\n${body}`;
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > skill.bytes.byteLength + 4096)
    throw new Error(
      "Compatible metadata would exceed its bounded adaptation overhead",
    );
  const digest = sha256(skill.bytes);
  const existing = new Set(
    files.map((file) => file.path.split("/")[0]!.toLowerCase()),
  );
  let backup = `.sourceweft-original-${digest.slice(0, 12)}.md`;
  if (existing.has(backup)) backup = `.sourceweft-original-${digest}.md`;
  for (let suffix = 1; existing.has(backup.toLowerCase()); suffix++)
    backup = `.sourceweft-original-${digest}-${suffix}.md`;
  return {
    files: [
      ...files.map((file) =>
        file.path === "SKILL.md" ? { path: file.path, bytes } : file,
      ),
      { path: backup, bytes: skill.bytes },
    ],
    sourceFiles: Object.fromEntries(
      files.map((file) => [file.path, sha256(file.bytes)]),
    ),
    originalSkillMd: backup,
  };
}
