import { describe, expect, it } from "vitest";
import { getAssistantToolTitle } from "./assistant-tool-display";
import type { ToolCallRecord } from "./types";

function skillRead(path: string): ToolCallRecord {
  return {
    id: `call-${path}`,
    tool: "read_file",
    status: "completed",
    input: { path, filesystemScope: "skills", visibility: "internal_instruction" },
  } as unknown as ToolCallRecord;
}

describe("getAssistantToolTitle — skill instruction reads", () => {
  it("labels SKILL.md as loading the skill's instructions", () => {
    expect(
      getAssistantToolTitle(skillRead("/skills/internal-comms/SKILL.md")),
    ).toBe("Load Internal Comms skill instructions");
  });

  it("names the file for the reference files a skill points at", () => {
    // Progressive disclosure reads several files per turn. Before this, all
    // three rows below read "Load Internal Comms skill instructions", which
    // looked like the agent repeating itself rather than following the skill.
    const titles = [
      "/skills/internal-comms/SKILL.md",
      "/skills/internal-comms/examples/company-newsletter.md",
      "/skills/internal-comms/examples/general-comms.md",
    ].map((path) => getAssistantToolTitle(skillRead(path)));

    expect(new Set(titles).size).toBe(3);
    expect(titles[1]).toBe(
      "Read examples/company-newsletter.md from Internal Comms",
    );
  });

  it("falls back to the plain label when the skill cannot be named", () => {
    expect(getAssistantToolTitle(skillRead("/skills"))).toBe(
      "Load skill instructions",
    );
  });
});
