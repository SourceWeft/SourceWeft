import { describe, expect, it } from "vitest";
import { fitSeoTitle, SEO_TITLE_MAX_LENGTH } from "./seo-title";

const skill = (name: string) => `${name} Agent Skill`;
const mcp = (name: string) => `${name} MCP Server`;
const full = (title: string) => Array.from(`${title} | SourceWeft`).length;

describe("fitSeoTitle", () => {
  it("keeps an ordinary name untouched", () => {
    expect(fitSeoTitle(skill, "Discover Brand", "x")).toBe(
      "Discover Brand Agent Skill",
    );
  });

  it("shortens an overlong name so the full title fits", () => {
    const title = fitSeoTitle(
      skill,
      "Discover Brand · partner-built/brand-voice/skills/discover-brand",
      "x",
    );
    expect(full(title)).toBeLessThanOrEqual(SEO_TITLE_MAX_LENGTH);
    expect(title.startsWith("Discover Brand")).toBe(true);
    expect(title.endsWith("… Agent Skill")).toBe(true);
  });

  it("counts CJK names per character and never splits one", () => {
    const name = "智能体技能".repeat(12);
    const title = fitSeoTitle((n) => `${n} 智能体技能`, name, "x");
    expect(full(title)).toBeLessThanOrEqual(SEO_TITLE_MAX_LENGTH);
    expect(title).toContain("…");
    expect(title).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("does not split surrogate pairs", () => {
    const title = fitSeoTitle(mcp, "𠮷".repeat(80), "x");
    expect(title).not.toMatch(/[\uD800-\uDFFF](?![\uDC00-\uDFFF])/u);
    expect(full(title)).toBeLessThanOrEqual(SEO_TITLE_MAX_LENGTH);
  });

  it("falls back when the name is missing or blank", () => {
    expect(fitSeoTitle(skill, "   ", "my-slug")).toBe("my-slug Agent Skill");
    expect(fitSeoTitle(mcp, null, "io.example/server")).toBe(
      "io.example/server MCP Server",
    );
  });

  it("cuts a single unbroken long name", () => {
    const title = fitSeoTitle(mcp, "a".repeat(120), "x");
    expect(full(title)).toBeLessThanOrEqual(SEO_TITLE_MAX_LENGTH);
  });
});
