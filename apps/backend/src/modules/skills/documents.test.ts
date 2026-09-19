import { expect, test } from "vitest";
import { readSkillDocuments } from "./documents";

test("prefers the bundle README without altering source bytes", () => {
  const files = [
    { path: "README.zh-CN.md", contentText: "中文" },
    { path: "readme.md", contentText: "lowercase" },
    { path: "README.md", contentText: "\n# Original\n" },
    { path: "SKILL.md", contentText: "---\nname: skill\n---\nBody" },
  ];
  expect(readSkillDocuments(files)).toEqual({
    readmeContent: "\n# Original\n",
    readmePath: "README.md",
    skillContent: files[3]!.contentText,
  });
  expect(readSkillDocuments([...files].reverse())).toEqual(
    readSkillDocuments(files),
  );
});

test("recognizes alternate names but never borrows a nested skill README", () => {
  expect(
    readSkillDocuments([{ path: "readme.md", contentText: "intro" }])
      .readmePath,
  ).toBe("readme.md");
  expect(
    readSkillDocuments([{ path: "README.zh-CN.md", contentText: "说明" }])
      .readmePath,
  ).toBe("README.zh-CN.md");
  expect(
    readSkillDocuments([
      { path: "references/README.md", contentText: "unrelated" },
      { path: "README.md", contentText: "  \n" },
    ]),
  ).toEqual({ readmeContent: null, readmePath: null, skillContent: null });
});

test("a skill-only bundle remains available for introduction display", () => {
  expect(
    readSkillDocuments([{ path: "SKILL.md", contentText: "# Skill" }]),
  ).toEqual({ readmeContent: null, readmePath: null, skillContent: "# Skill" });
});
