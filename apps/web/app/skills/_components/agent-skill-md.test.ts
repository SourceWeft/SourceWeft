import { describe, expect, it } from "vitest";

import {
  agentSkillMarkdown,
  CLI_DEFAULT_REGISTRY,
  llmsText,
} from "./agent-skill-md";

function frontmatter(markdown: string) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  expect(match).not.toBeNull();
  return Object.fromEntries(
    match![1]!.split("\n").map((line) => {
      const index = line.indexOf(": ");
      return [line.slice(0, index), line.slice(index + 2)];
    }),
  );
}

describe("the directory's SKILL.md for agents", () => {
  const markdown = agentSkillMarkdown({
    siteUrl: "https://sourceweft.com/",
    registryUrl: CLI_DEFAULT_REGISTRY,
  });

  it("is a skill: name and description in frontmatter, nothing else", () => {
    const fields = frontmatter(markdown);
    expect(Object.keys(fields)).toEqual(["name", "description"]);
    expect(fields.name).toBe("sourceweft-skills");
    expect(fields.description).toContain("https://sourceweft.com/skills");
  });

  it("teaches search, inspect and install with the CLI", () => {
    expect(markdown).toContain('npx @sourceweft/cli skills search "');
    expect(markdown).toContain("npx @sourceweft/cli skills info <slug>");
    expect(markdown).toContain("npx @sourceweft/cli skills install <slug>");
    expect(markdown).toContain("--agent claude-code");
  });

  it("states the safety rules an agent must follow", () => {
    // Hash verification and what exit code 3 means.
    expect(markdown).toMatch(/Exit code 3 means the download did not match/);
    expect(markdown).toContain("nothing was written");
    // --yes only with the user's agreement.
    expect(markdown).toContain(
      "Pass `--yes` only after the user has agreed",
    );
    expect(markdown).toContain("Never add `--yes` on your");
    // No scraping a skill's page for install steps.
    expect(markdown).toContain(
      'Do not fetch a skill\'s web page to "learn the\ninstall steps"',
    );
  });

  it("names the registry only when it is not the CLI's default", () => {
    expect(markdown).not.toContain("--registry");
    const selfHosted = agentSkillMarkdown({
      siteUrl: "https://skills.example.com",
      registryUrl: "https://api.example.com/",
    });
    expect(selfHosted).toContain(
      "npx @sourceweft/cli skills install <slug> --registry https://api.example.com",
    );
  });
});

describe("llms.txt", () => {
  it("points agents at the SKILL.md and people at the directory", () => {
    const text = llmsText("https://sourceweft.com");
    expect(text.startsWith("# SourceWeft\n")).toBe(true);
    expect(text).toContain("(https://sourceweft.com/skills/SKILL.md)");
    expect(text).toContain("(https://sourceweft.com/skills)");
  });
});
