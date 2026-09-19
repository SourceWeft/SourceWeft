import { test, expect } from "vitest";
import { parseSkillFrontmatter, SkillParseError } from "./frontmatter";
import { readAllowedTools } from "./registry/analyze";

for (const newline of ["\n", "\r\n"])
  for (const bom of ["", "\uFEFF"]) {
    test(`frontmatter preserves values with ${JSON.stringify({ newline, bom })}`, () => {
      const content =
        bom +
        [
          "---",
          "name: writer",
          "description: |",
          "  First line",
          "  Second line",
          "---",
        ].join(newline);
      const before = Buffer.from(content);
      expect(parseSkillFrontmatter(content)).toMatchObject({
        name: "writer",
        description: "First line\nSecond line\n",
      });
      expect(Buffer.from(content)).toEqual(before);
    });
  }
test("missing and invalid metadata are distinct; diagnostics don't expose secrets", () => {
  expect(parseSkillFrontmatter("No header\n---\n")).toBeNull();
  expect(() => parseSkillFrontmatter("---\nname: x")).toThrow(SkillParseError);
  expect(() => parseSkillFrontmatter("---\n- item\n---")).toThrow(/mapping/);
  expect(() =>
    parseSkillFrontmatter("---\nname: writer\nname: private-secret\n---"),
  ).toThrow(/DUPLICATE_KEY/);
  try {
    parseSkillFrontmatter("---\nname: writer\nname: private-secret\n---");
  } catch (error) {
    expect(error).toMatchObject({ line: 3 });
    expect((error as Error).message).not.toContain("private-secret");
  }
});
test("body separators don't interfere with metadata", () => {
  expect(
    parseSkillFrontmatter(
      "---\nname: writer\ndescription: text\n---\nBody\n---\nmore",
    ),
  ).toEqual({ name: "writer", description: "text" });
});
test("tool declarations preserve parenthesized spaces and reject conflicting aliases", () => {
  expect(
    readAllowedTools({ "allowed-tools": "Read Bash(git log --oneline) Grep" }),
  ).toEqual(["Read", "Bash(git log --oneline)", "Grep"]);
  expect(
    readAllowedTools({
      "allowed-tools": "Read, Grep",
      allowed_tools: ["Grep", "Read"],
    }),
  ).toEqual(["Read", "Grep"]);
  expect(() => readAllowedTools({ "allowed-tools": ["Read", 42] })).toThrow();
  expect(() =>
    readAllowedTools({ "allowed-tools": "Bash(unclosed" }),
  ).toThrow();
  expect(() =>
    readAllowedTools({ "allowed-tools": "Read", allowedTools: "Bash" }),
  ).toThrow();
});

test("YAML alias expansion remains bounded", () => {
  const yaml =
    "---\na: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\n---";
  expect(() => parseSkillFrontmatter(yaml)).toThrow(SkillParseError);
});
