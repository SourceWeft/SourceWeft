import { describe, expect, it } from "vitest";
import { normalizeToolChoice } from "../../src/compat/tool-choice";

describe("normalizeToolChoice", () => {
  it("maps any to required", () => {
    expect(normalizeToolChoice("any")).toBe("required");
  });

  it("maps true to required", () => {
    expect(normalizeToolChoice(true)).toBe("required");
  });

  it("maps false to none", () => {
    expect(normalizeToolChoice(false)).toBe("none");
  });

  it("passes through object tool choice", () => {
    const choice = {
      type: "function",
      function: {
        name: "get_weather",
      },
    };
    expect(normalizeToolChoice(choice)).toEqual(choice);
  });
});
