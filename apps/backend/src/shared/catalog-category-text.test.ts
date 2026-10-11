import { expect, test } from "vitest";
import { catalogCategoryText } from "./catalog-category-text";

const finance = {
  name: "Finance",
  description: "Stocks, crypto, trading, accounting and banking.",
  zhCN: { name: "金融", description: "股票、加密货币、交易、会计与银行。" },
};

test("English is the taxonomy's own wording, Simplified Chinese its translation", () => {
  expect(catalogCategoryText(finance, "en")).toEqual({
    name: "Finance",
    description: "Stocks, crypto, trading, accounting and banking.",
  });
  expect(catalogCategoryText(finance, "zh-CN")).toEqual(finance.zhCN);
});

test("Traditional Chinese is generated from it with Taiwan usage", () => {
  expect(catalogCategoryText(finance, "zh-TW")).toEqual({
    name: "金融",
    description: "股票、加密貨幣、交易、會計與銀行。",
  });
  // The shared glossary, not just OpenCC: 营销 → 行銷, 运维 → 維運.
  expect(
    catalogCategoryText(
      { ...finance, zhCN: { name: "营销与运维", description: "云盘" } },
      "zh-TW",
    ),
  ).toEqual({ name: "行銷與維運", description: "雲端硬碟" });
});
