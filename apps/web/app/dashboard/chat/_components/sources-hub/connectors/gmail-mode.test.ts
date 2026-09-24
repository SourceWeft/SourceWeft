import { describe, expect, it } from "vitest";
import { gmailConfigForMode, parseGmailUsageMode } from "./gmail-mode";

describe("Gmail connection mode", () => {
  it.each([
    ["tools", true, false],
    ["index", false, true],
    ["both", true, true],
  ] as const)("maps %s to live and indexed access", (mode, live, index) => {
    expect(gmailConfigForMode(mode)).toMatchObject({
      liveSearchEnabled: live,
      indexingEnabled: index,
    });
  });

  it("defaults unknown URL values to tools only", () => {
    expect(parseGmailUsageMode(null)).toBe("tools");
    expect(parseGmailUsageMode("all")).toBe("tools");
  });
});
