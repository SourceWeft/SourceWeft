// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import type { MarketSkillSummary } from "@sourceweft/market-sdk";
import messages from "../../../../../messages/en.json";

const market = vi.hoisted(() => ({ getPublicSkill: vi.fn() }));
vi.mock("../../../../../lib/market-skills", () => ({
  getPublicSkill: market.getPublicSkill,
  marketSkillLocale: (locale: string) =>
    ["en", "zh-CN", "zh-TW"].includes(locale) ? locale : "en",
}));

import { PublicSkillOverview } from "./public-skill-overview";
import { publicOverviewCopy } from "./public-overview-copy";
import { SkillMarketCard, skillCardText } from "../skills-display";

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.resetAllMocks();
});

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];

async function render(node: ReactNode, locale = "en") {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale={locale} messages={intlMessages}>
        {node}
      </NextIntlClientProvider>,
    ),
  );
}

const overview = {
  summary: "从 PDF 表单中填写字段。",
  whatItDoes: "<script>alert(1)</script> 读取表单并填写。",
  whenToUse: "收到表单时。",
  requirements: "需要 Python 3。",
  locale: "zh-CN" as const,
  generatedAt: "2026-09-22T00:00:00.000Z",
};

test("the overview is read in the page's locale and shown as labelled plain text", async () => {
  market.getPublicSkill.mockResolvedValue({ aiOverview: overview });
  const node = await PublicSkillOverview({
    slug: "gh-acme-skills-pdf",
    signedIn: false,
    locale: "zh-CN",
  });
  expect(market.getPublicSkill).toHaveBeenCalledWith(
    "gh-acme-skills-pdf",
    "zh-CN",
  );
  await render(node, "zh-CN");
  const block = container.querySelector('[data-testid="skill-ai-overview"]');
  expect(block?.textContent).toContain("AI 生成的概览");
  expect(block?.textContent).toContain("适用场景");
  expect(block?.textContent).toContain("<script>alert(1)</script>");
  expect(container.querySelector("script")).toBeNull();
  // In the language asked for: no fallback note.
  expect(block?.textContent).not.toContain("以下为英文版本");
});

test("an English fallback is noted in the visitor's language", async () => {
  market.getPublicSkill.mockResolvedValue({
    aiOverview: { ...overview, summary: "Fills PDF forms.", locale: "en" },
  });
  const node = await PublicSkillOverview({
    slug: "pdf",
    signedIn: true,
    locale: "zh-TW",
  });
  await render(node, "zh-TW");
  expect(container.textContent).toContain("AI 產生的概覽");
  expect(container.textContent).toContain("以下為英文版本");
});

test("nothing renders without an overview, or when the read fails", async () => {
  market.getPublicSkill.mockResolvedValue({ aiOverview: null });
  expect(
    await PublicSkillOverview({ slug: "a", signedIn: false, locale: "en" }),
  ).toBeNull();
  market.getPublicSkill.mockResolvedValue({});
  expect(
    await PublicSkillOverview({ slug: "a", signedIn: false, locale: "en" }),
  ).toBeNull();
  market.getPublicSkill.mockRejectedValue(new Error("down"));
  expect(
    await PublicSkillOverview({ slug: "a", signedIn: false, locale: "en" }),
  ).toBeNull();
});

test("copy falls back to English for an unknown locale", () => {
  expect(publicOverviewCopy("fr").block.title).toBe("AI-generated overview");
});

const summary: MarketSkillSummary = {
  slug: "gh-acme-skills-pdf",
  name: "pdf",
  displayName: "PDF",
  description: "The author's own description.",
  logo: null,
  categories: [],
  verified: false,
  featured: false,
  capability: "prompt-only",
  license: null,
  author: "acme",
  repoUrl: null,
  sourceUrl: null,
  installCount: 0,
  listedAt: "2026-09-01T00:00:00.000Z",
  version: "abc",
  updatedAt: null,
  stars: 0,
  repoPushedAt: null,
  repoArchived: false,
  claimed: false,
};

test("a card shows the AI summary when there is one, else the description", async () => {
  expect(skillCardText({ description: "d", aiSummary: "  " })).toEqual({
    text: "d",
    ai: false,
  });
  expect(skillCardText({ description: "d" })).toEqual({
    text: "d",
    ai: false,
  });

  await render(
    <SkillMarketCard skill={{ ...summary, aiSummary: "Fills PDF forms." }} />,
  );
  const text = container.querySelector("[data-ai-summary]");
  expect(text?.textContent).toBe("Fills PDF forms.");
  expect(text?.getAttribute("title")).toBe("AI-generated summary");
  expect(container.textContent).not.toContain("The author's own description.");

  act(() => root.unmount());
  container.remove();
  await render(<SkillMarketCard skill={{ ...summary, aiSummary: null }} />);
  expect(container.querySelector("[data-ai-summary]")).toBeNull();
  expect(container.textContent).toContain("The author's own description.");
});
