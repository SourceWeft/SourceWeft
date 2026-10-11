import { describe, expect, it, vi } from "vitest";

// next-intl reads its request config through the Next plugin, which a unit
// test does not have: serve the real catalogs directly instead.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { deepMergeMessages } = await import("@sourceweft/i18n/catalog");
  const en = (await import("../messages/en.json")).default;
  return {
    getTranslations: async ({
      locale,
      namespace,
    }: {
      locale: string;
      namespace: string;
    }) =>
      createTranslator({
        locale,
        messages:
          locale === "en"
            ? en
            : deepMergeMessages(
                en,
                (await import(`../messages/${locale}.json`)).default,
              ),
        namespace: namespace as never,
      }),
  };
});

import { localizeMarketCategories } from "./market-categories";

const finance = {
  id: "c1",
  slug: "finance",
  name: "Finance",
  description:
    "Stocks, crypto, trading, accounting, banking, markets, and financial data.",
};
const development = {
  slug: "development",
  name: "Software Development",
  description: "Writing, reviewing, testing and debugging code.",
  count: 12,
};
const unknown = {
  id: "c2",
  slug: "brand-new",
  name: "Brand New",
  description: null,
};

describe("localizeMarketCategories", () => {
  it("names and describes catalog categories in the page's language", async () => {
    const [mcp] = await localizeMarketCategories("mcp", [finance], "zh-CN");
    expect(mcp).toEqual({
      ...finance,
      name: "金融",
      description: expect.stringMatching(/^股票、加密货币/),
    });

    const [skill] = await localizeMarketCategories(
      "skills",
      [development],
      "zh-TW",
    );
    expect(skill).toMatchObject({ count: 12, name: "軟體開發" });
    expect(skill!.description).toMatch(/程式碼/);
  });

  it("keeps the taxonomy's own English, and any category without a translation", async () => {
    expect(await localizeMarketCategories("mcp", [finance], "en")).toEqual([
      finance,
    ]);
    expect(await localizeMarketCategories("mcp", [unknown], "zh-CN")).toEqual([
      unknown,
    ]);
  });
});
