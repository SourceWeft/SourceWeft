/** A run of text under one heading; `path` is null before the first heading. */
export type MarkdownSection = {
  readonly start: number;
  readonly path: string | null;
};

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MAX_HEADING_CHARS = 200;

/**
 * Markdown ATX headings outside fenced code, as section boundaries. Each
 * section's path joins its heading with its ancestors: "Guide > Install".
 */
export function markdownSections(text: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [{ start: 0, path: null }];
  const trail: { level: number; title: string }[] = [];
  let fence: string | null = null;
  let offset = 0;

  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;

    const fenceMatch = FENCE.exec(line);
    if (fence) {
      const closing = fenceMatch?.[1];
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }

    const heading = ATX_HEADING.exec(line.replace(/\r$/, ""));
    const title = heading?.[2]?.trim().slice(0, MAX_HEADING_CHARS);
    if (!heading || !title) continue;

    const level = heading[1]!.length;
    while (trail.length > 0 && trail[trail.length - 1]!.level >= level) {
      trail.pop();
    }
    trail.push({ level, title });
    sections.push({
      start: lineStart,
      path: trail.map((entry) => entry.title).join(" > "),
    });
  }

  return sections[1]?.start === 0 ? sections.slice(1) : sections;
}

/** The path of the section that holds the most of [startIndex, endIndex). */
export function headingPathOf(
  sections: readonly MarkdownSection[],
  startIndex: number,
  endIndex: number,
): string | null {
  let best: string | null = null;
  let bestChars = 0;
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]!;
    const sectionEnd = sections[index + 1]?.start ?? Number.POSITIVE_INFINITY;
    const chars =
      Math.min(endIndex, sectionEnd) - Math.max(startIndex, section.start);
    if (chars > bestChars) {
      best = section.path;
      bestChars = chars;
    }
  }
  return best;
}
