import { describe, expect, it } from "vitest";

import { SITE_URL } from "../../app/seo";
import { buildAlternates, buildTranslatedAlternates } from "./metadata";

const url = (path: string) => `${SITE_URL}${path}`;

describe("buildAlternates", () => {
  it("links every locale and points canonical at this one", () => {
    expect(buildAlternates("/skills", "zh-CN")).toEqual({
      canonical: url("/zh-CN/skills"),
      languages: {
        en: url("/skills"),
        "zh-CN": url("/zh-CN/skills"),
        "zh-TW": url("/zh-TW/skills"),
        "x-default": url("/skills"),
      },
    });
  });
});

describe("buildTranslatedAlternates", () => {
  it("keeps an untranslated page a copy of the English one", () => {
    expect(buildTranslatedAlternates("/skills/x", "zh-CN", [])).toEqual({
      canonical: url("/skills/x"),
    });
  });

  it("links only the translated locales", () => {
    expect(buildTranslatedAlternates("/skills/x", "zh-CN", ["zh-CN"])).toEqual({
      canonical: url("/zh-CN/skills/x"),
      languages: {
        en: url("/skills/x"),
        "zh-CN": url("/zh-CN/skills/x"),
        "x-default": url("/skills/x"),
      },
    });
  });

  it("sends a locale without a translation to the English canonical", () => {
    expect(
      buildTranslatedAlternates("/skills/x", "zh-TW", ["zh-CN"]).canonical,
    ).toBe(url("/skills/x"));
  });

  it("gives the English page the same hreflang set", () => {
    expect(
      buildTranslatedAlternates("/skills/x", "en", ["zh-CN", "zh-TW"]),
    ).toEqual({
      canonical: url("/skills/x"),
      languages: {
        en: url("/skills/x"),
        "zh-CN": url("/zh-CN/skills/x"),
        "zh-TW": url("/zh-TW/skills/x"),
        "x-default": url("/skills/x"),
      },
    });
  });
});
