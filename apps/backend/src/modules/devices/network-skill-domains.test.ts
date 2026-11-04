import { describe, expect, test } from "vitest";
import { resolveSkillNetworkDomains } from "./network-skill-domains";

const md = (domains: string[]) =>
  `---\nname: s\nnetwork-domains:\n${domains.map((d) => `  - "${d}"`).join("\n")}\n---\nBody`;

describe("resolveSkillNetworkDomains", () => {
  test("builtin skills are allowed outright, every other source only suggests", () => {
    const result = resolveSkillNetworkDomains([
      { name: "pdf", sourceType: "builtin", skillMd: md(["api.pdf.example"]) },
      {
        name: "mine",
        sourceType: "workspace_custom",
        skillMd: md(["evil.example", "*.cdn.example"]),
      },
      { name: "team", sourceType: "team_custom", skillMd: md(["t.example"]) },
      { name: "gh", sourceType: "registry_github", skillMd: md(["g.example"]) },
    ]);
    expect(result.trusted).toEqual(["api.pdf.example"]);
    expect(result.suggested).toEqual({
      "evil.example": "mine",
      "*.cdn.example": "mine",
      "t.example": "team",
      "g.example": "gh",
    });
  });

  test("a domain a trusted skill declares is never merely suggested", () => {
    const result = resolveSkillNetworkDomains([
      {
        name: "mine",
        sourceType: "workspace_custom",
        skillMd: md(["x.example"]),
      },
      { name: "pdf", sourceType: "builtin", skillMd: md(["x.example"]) },
    ]);
    expect(result.trusted).toEqual(["x.example"]);
    expect(result.suggested).toEqual({});
  });

  test("the first skill to ask for a domain is the one named", () => {
    const result = resolveSkillNetworkDomains([
      { name: "a", sourceType: "workspace_custom", skillMd: md(["x.example"]) },
      { name: "b", sourceType: "workspace_custom", skillMd: md(["x.example"]) },
    ]);
    expect(result.suggested).toEqual({ "x.example": "a" });
  });

  test("invalid, missing or malformed declarations contribute nothing", () => {
    const result = resolveSkillNetworkDomains([
      {
        name: "a",
        sourceType: "builtin",
        skillMd: md(["*", "*.com", "10.0.0.1", "ok.example"]),
      },
      { name: "b", sourceType: "builtin" },
      { name: "c", sourceType: "builtin", skillMd: "---\nname: [unclosed" },
      { name: "d", sourceType: "builtin", skillMd: "no frontmatter" },
      { name: "e", sourceType: "unknown_source", skillMd: md(["u.example"]) },
    ]);
    expect(result.trusted).toEqual(["ok.example"]);
    expect(result.suggested).toEqual({ "u.example": "e" });
  });
});
