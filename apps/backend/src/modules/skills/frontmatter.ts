import { LineCounter, parseDocument } from "yaml";

export type SkillFrontmatter = Record<string, unknown>;

export class SkillParseError extends Error {
  readonly code = "SKILL_YAML_INVALID";
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
    this.name = "SkillParseError";
  }
}

/** Null means absent; malformed metadata throws. Never normalize stored bytes. */
export function parseSkillFrontmatter(
  content: string,
): SkillFrontmatter | null {
  const view = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const opening = /^---[ \t]*(?:\r?\n|$)/.exec(view);
  if (!opening) return null;
  const start = opening[0].length;
  const closing = /^---[ \t]*(?:\r?$)/m.exec(view.slice(start));
  if (!closing)
    throw new SkillParseError(
      "SKILL.md frontmatter is not closed with ---",
      1,
      1,
    );
  const yaml = view.slice(start, start + closing.index);
  const lineCounter = new LineCounter();
  const document = parseDocument(yaml, { lineCounter, uniqueKeys: true });
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) {
    const position = lineCounter.linePos(problem.pos[0]);
    // YAML messages can include secret values/source excerpts. Report a safe code.
    throw new SkillParseError(
      `Invalid SKILL.md YAML (${problem.code})`,
      position.line + 1,
      position.col,
    );
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch {
    throw new SkillParseError(
      "SKILL.md YAML exceeds safe alias expansion limits",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillParseError("SKILL.md frontmatter must be a mapping", 2, 1);
  }
  return value as SkillFrontmatter;
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
