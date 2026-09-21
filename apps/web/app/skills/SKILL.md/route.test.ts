import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /skills/SKILL.md", () => {
  it("serves the agents' SKILL.md as markdown", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    const body = await response.text();
    expect(body.startsWith("---\nname: sourceweft-skills\n")).toBe(true);
    expect(body).toContain("npx @sourceweft/cli skills install <slug>");
  });
});
