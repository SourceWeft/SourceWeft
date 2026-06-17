import { parse as parseYaml } from "yaml";

export type SkillFrontmatter = Record<string, unknown>;

export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) {
    return {};
  }

  const parsed = parseYaml(match[1] ?? "") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as SkillFrontmatter;
}

export function getSourceWeftFrontmatter(
  frontmatter: SkillFrontmatter,
): Record<string, unknown> {
  const nested = frontmatter.sourceweft;
  const sourceweft =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? { ...(nested as Record<string, unknown>) }
      : {};

  for (const [key, value] of Object.entries(frontmatter)) {
    if (key.startsWith("sourceweft.")) {
      sourceweft[key.slice("sourceweft.".length)] = value;
    }
  }

  return sourceweft;
}
