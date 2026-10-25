import { describe, expect, it } from "vitest";

import { untrustedLine } from "./untrusted-line";

describe("untrustedLine", () => {
  it("flattens line breaks, controls and backticks into one line", () => {
    expect(untrustedLine("a\n\n# b\t`c`\u001b[31m", 100)).toBe("a # b c [31m");
  });

  it("removes invisible format characters that can carry hidden text", () => {
    const hidden = [
      "\u200B", // zero-width space
      "\u200D", // zero-width joiner
      "\u2060", // word joiner
      "\uFEFF", // byte order mark
      "\u202E", // right-to-left override
      "\u{E0049}\u{E0067}\u{E006E}", // tag characters spelling "Ign"
      "\uFE0F", // variation selector 16
      "\u{E0100}", // variation selector 17
    ].join("");
    const text = untrustedLine(`ab${hidden}cd`, 100);
    expect(text).toBe("ab cd");
    expect(/[\p{Cf}\p{Mn}]/u.test(text)).toBe(false);
  });

  it("caps the length", () => {
    expect(untrustedLine("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
