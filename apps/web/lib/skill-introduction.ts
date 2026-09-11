export type SkillIntroductionInput = {
  readmeContent?: string | null;
  readmePath?: string | null;
  skillContent?: string | null;
  displayName: string;
  description: string;
};

export function resolveSkillIntroduction(input: SkillIntroductionInput) {
  if (input.readmeContent?.trim()) {
    return {
      content: input.readmeContent,
      source: input.readmePath ?? "README.md",
    };
  }
  // Strip only a complete leading frontmatter block; retain all original body markdown.
  const body = (input.skillContent ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
    .trim();
  return { content: body || null, source: body ? "SKILL.md" : null };
}
