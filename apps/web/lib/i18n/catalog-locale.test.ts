import { describe, expect, it } from "vitest";
import {
  marketMcpLocaleSchema,
  marketSkillLocaleSchema,
} from "@sourceweft/market-contracts";

import { catalogLocale } from "./catalog-locale";

describe("catalogLocale", () => {
  it.each([
    ["en", "en"],
    ["zh-CN", "zh-CN"],
    ["zh-TW", "zh-TW"],
    // UI locales the catalog does not write in read in English.
    ["ja", "en"],
    ["zh", "en"],
    ["", "en"],
    [null, "en"],
    [undefined, "en"],
  ] as const)("maps %j to %j", (locale, expected) => {
    expect(catalogLocale(locale)).toBe(expected);
  });

  it("covers every locale the catalog writes in, for MCP servers and skills", () => {
    // Skills have their own locale enum; one gaining a language must not be
    // read in English here without a test failing.
    for (const locale of [
      ...marketMcpLocaleSchema.options,
      ...marketSkillLocaleSchema.options,
    ])
      expect(catalogLocale(locale)).toBe(locale);
  });
});
