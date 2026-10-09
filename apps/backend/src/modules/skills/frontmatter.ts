import type { SkillFrontmatter } from "@sourceweft/skill-format";
export {
  parseSkillFrontmatter,
  SkillParseError,
  type SkillFrontmatter,
} from "@sourceweft/skill-format";

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
