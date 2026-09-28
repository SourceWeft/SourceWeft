// @vitest-environment jsdom
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import zhCNMessages from "../../../../../messages/zh-CN.json";
import zhTWMessages from "../../../../../messages/zh-TW.json";

// Pins the markup a skill's AI overview renders, on the public page (server
// render) and in the dashboard (client mount), in all three languages. The
// snapshots were recorded before the overview moved onto the shared catalog
// component, so any change in what skills show fails here.

const market = vi.hoisted(() => ({ getPublicSkill: vi.fn() }));
vi.mock("../../../../../lib/market-skills", () => ({
  getPublicSkill: market.getPublicSkill,
  marketSkillLocale: (locale: string) =>
    ["en", "zh-CN", "zh-TW"].includes(locale) ? locale : "en",
}));
const api = vi.hoisted(() => ({ getSkillAiOverview: vi.fn() }));
vi.mock("../../../../../lib/skill-overviews", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../../lib/skill-overviews")
  >()),
  getSkillAiOverview: api.getSkillAiOverview,
}));
// The explainer lives in a tooltip that only mounts when opened, and an open
// Radix tooltip never settles in jsdom. Render its content in place instead,
// so the explainer's text is pinned with the rest.
vi.mock("@sourceweft/ui-web/components/ui/tooltip", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@sourceweft/ui-web/components/ui/tooltip")
  >()),
  TooltipContent: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => (
    <div className={className} data-slot="tooltip-content">
      {children}
    </div>
  ),
}));

import { PublicSkillOverview } from "../../../../[locale]/skills/_components/community/public-skill-overview";
import { SkillAiOverview } from "./skill-ai-overview";
import { SkillAiOverviewView } from "./skill-ai-overview-view";
import {
  type IntlOptions,
  messages,
  mountWithIntl,
  unmountAll,
  withIntl,
} from "@/test/react";

afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});

type IntlMessages = IntlOptions["messages"];
const catalogs: Record<string, IntlMessages> = {
  en: messages,
  "zh-CN": zhCNMessages as IntlMessages,
  "zh-TW": zhTWMessages as IntlMessages,
};

const full = {
  summary: "Fills PDF forms <b>fast</b>.",
  whatItDoes: "Reads a form.\nFills its fields.",
  whenToUse: "When a form arrives.",
  requirements: "Python 3 and **pypdf**.",
  locale: "en" as const,
  generatedAt: "2026-09-22T00:00:00.000Z",
};
const sparse = { ...full, whenToUse: "  ", requirements: "" };

/**
 * The DOM as an indented outline: one element per line with its attributes
 * in name order, text nodes quoted. An icon's <svg> keeps its attributes
 * (its lucide class names it) but not its path data.
 */
function outline(root: ParentNode): string {
  const lines: string[] = [];
  const walk = (node: Node, depth: number) => {
    const pad = "  ".repeat(depth);
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) {
        lines.push(`${pad}${JSON.stringify(node.textContent)}`);
      }
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();
    const attributes = [...node.attributes]
      .map((attribute) => `${attribute.name}="${attribute.value}"`)
      .sort();
    lines.push(`${pad}<${[tag, ...attributes].join(" ")}>`);
    if (tag === "svg") return;
    node.childNodes.forEach((child) => walk(child, depth + 1));
  };
  root.childNodes.forEach((child) => walk(child, 0));
  return lines.join("\n");
}

function serverOutline(node: ReactNode, locale: string) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    withIntl(node, { locale, messages: catalogs[locale] }),
  );
  return outline(host);
}

test("the dashboard view, server-rendered in English with every section", () => {
  expect(
    serverOutline(
      <SkillAiOverviewView overview={full} requestedLocale="en" />,
      "en",
    ),
  ).toMatchInlineSnapshot(`
    "<section aria-label="AI-generated overview" class="mb-4 rounded-lg border border-dashed bg-muted/30 p-4 text-sm" data-testid="skill-ai-overview">
      <div class="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <svg aria-hidden="true" class="lucide lucide-sparkles size-3.5" fill="none" height="24" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" stroke="currentColor" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg">
        <span>
          "AI-generated overview"
        <button aria-label="About this overview" class="inline-flex text-muted-foreground hover:text-foreground" data-slot="tooltip-trigger" data-state="closed" type="button">
          <svg aria-hidden="true" class="lucide lucide-info size-3.5" fill="none" height="24" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" stroke="currentColor" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg">
        <div class="max-w-xs" data-slot="tooltip-content">
          "Written by an AI model from this skill's SKILL.md and file list. It can be wrong or incomplete — check the skill's own documentation before relying on it."
      <p class="font-medium text-foreground">
        "Fills PDF forms <b>fast</b>."
      <dl class="mt-3 grid gap-2">
        <div>
          <dt class="text-xs font-medium text-muted-foreground">
            "What it does"
          <dd class="whitespace-pre-line text-foreground/90">
            "Reads a form.\\nFills its fields."
        <div>
          <dt class="text-xs font-medium text-muted-foreground">
            "When to use it"
          <dd class="whitespace-pre-line text-foreground/90">
            "When a form arrives."
        <div>
          <dt class="text-xs font-medium text-muted-foreground">
            "Requirements"
          <dd class="whitespace-pre-line text-foreground/90">
            "Python 3 and **pypdf**.""
  `);
});

test("the public page's overview, server-rendered in zh-CN", async () => {
  market.getPublicSkill.mockResolvedValue({
    aiOverview: { ...full, locale: "zh-CN" },
  });
  const node = await PublicSkillOverview({
    slug: "gh-acme-skills-pdf",
    signedIn: false,
    locale: "zh-CN",
  });
  expect(serverOutline(node, "zh-CN")).toMatchInlineSnapshot(`
    "<section aria-label="AI 生成的概览" class="mb-4 rounded-lg border border-dashed bg-muted/30 p-4 text-sm" data-testid="skill-ai-overview">
      <div class="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <svg aria-hidden="true" class="lucide lucide-sparkles size-3.5" fill="none" height="24" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" stroke="currentColor" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg">
        <span>
          "AI 生成的概览"
        <button aria-label="关于此概览" class="inline-flex text-muted-foreground hover:text-foreground" data-slot="tooltip-trigger" data-state="closed" type="button">
          <svg aria-hidden="true" class="lucide lucide-info size-3.5" fill="none" height="24" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" stroke="currentColor" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg">
        <div class="max-w-xs" data-slot="tooltip-content">
          "由 AI 模型根据该技能的 SKILL.md 和文件列表撰写，可能有误或不完整。使用前请以技能自身的文档为准。"
      <p class="font-medium text-foreground">
        "Fills PDF forms <b>fast</b>."
      <dl class="mt-3 grid gap-2">
        <div>
          <dt class="text-xs font-medium text-muted-foreground">
            "功能"
          <dd class="whitespace-pre-line text-foreground/90">
            "Reads a form.\\nFills its fields."
        <div>
          <dt class="text-xs font-medium text-muted-foreground">
            "适用场景"
          <dd class="whitespace-pre-line text-foreground/90">
            "When a form arrives."
        <div>
          <dt class="text-xs font-medium text-muted-foreground">
            "运行要求"
          <dd class="whitespace-pre-line text-foreground/90">
            "Python 3 and **pypdf**.""
  `);
});

test("the dashboard block, mounted in zh-TW, with empty sections and an English fallback", async () => {
  api.getSkillAiOverview.mockResolvedValue(sparse);
  const { container } = await mountWithIntl(
    <SkillAiOverview
      catalogId="cat_1"
      skillId="skill_1"
      slug="gh-acme-skills-pdf"
      workspaceId="ws_1"
    />,
    { locale: "zh-TW", messages: catalogs["zh-TW"] },
  );
  expect(outline(container)).toMatchInlineSnapshot(`
    "<section aria-label="AI 產生的概覽" class="mb-4 rounded-lg border border-dashed bg-muted/30 p-4 text-sm" data-testid="skill-ai-overview">
      <div class="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <svg aria-hidden="true" class="lucide lucide-sparkles size-3.5" fill="none" height="24" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" stroke="currentColor" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg">
        <span>
          "AI 產生的概覽"
        <button aria-label="關於此概覽" class="inline-flex text-muted-foreground hover:text-foreground" data-slot="tooltip-trigger" data-state="closed" type="button">
          <svg aria-hidden="true" class="lucide lucide-info size-3.5" fill="none" height="24" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" stroke="currentColor" viewBox="0 0 24 24" width="24" xmlns="http://www.w3.org/2000/svg">
        <div class="max-w-xs" data-slot="tooltip-content">
          "由 AI 模型根據該技能的 SKILL.md 和檔案列表撰寫，可能有誤或不完整。使用前請以技能自身的文件為準。"
      <p class="font-medium text-foreground">
        "Fills PDF forms <b>fast</b>."
      <dl class="mt-3 grid gap-2">
        <div>
          <dt class="text-xs font-medium text-muted-foreground">
            "功能"
          <dd class="whitespace-pre-line text-foreground/90">
            "Reads a form.\\nFills its fields."
      <p class="mt-3 text-xs text-muted-foreground">
        "暫無中文概覽，以下為英文版本。""
  `);
});
