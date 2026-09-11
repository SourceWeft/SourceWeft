import { expect, test } from "vitest";
import { resolveSkillIntroduction } from "./skill-introduction";

const metadata = { displayName: "Writer", description: "Writes reports" };
test("README takes precedence and keeps its source and original content", () => {
  expect(
    resolveSkillIntroduction({
      ...metadata,
      readmePath: "readme.md",
      readmeContent: "\n# Read me\n",
      skillContent: "Instructions",
    }),
  ).toEqual({ content: "\n# Read me\n", source: "readme.md" });
});
test.each(["\n", "\r\n"])(
  "skill-only overview removes frontmatter with %j line endings",
  (newline) => {
    const skillContent =
      "\uFEFF" +
      [
        "---",
        "name: writer",
        "description: private metadata",
        "---",
        "",
        "# Write",
        "",
        "---",
        "Keep this rule",
      ].join(newline);
    expect(
      resolveSkillIntroduction({
        ...metadata,
        readmeContent: "  ",
        skillContent,
      }),
    ).toEqual({
      content: ["# Write", "", "---", "Keep this rule"].join(newline),
      source: "SKILL.md",
    });
    expect(skillContent).toContain("description: private metadata");
  },
);
test("metadata-only skills request a summary, not a fabricated README", () => {
  expect(
    resolveSkillIntroduction({
      ...metadata,
      skillContent: "---\nname: writer\n---\n",
    }),
  ).toEqual({ content: null, source: null });
  expect(resolveSkillIntroduction(metadata)).toEqual({
    content: null,
    source: null,
  });
});
test("plain markdown and unclosed frontmatter are not silently discarded", () => {
  for (const skillContent of [
    "# Overview\n\n---\n\nBody",
    "---\nname: writer\nBody",
  ]) {
    expect(
      resolveSkillIntroduction({ ...metadata, skillContent }).content,
    ).toBe(skillContent);
  }
});
