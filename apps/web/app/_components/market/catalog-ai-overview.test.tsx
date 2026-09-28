// @vitest-environment jsdom
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import enMessages from "@/messages/en.json";
import zhCNMessages from "@/messages/zh-CN.json";
import zhTWMessages from "@/messages/zh-TW.json";

// The explainer lives in a tooltip that only mounts when opened, and an open
// Radix tooltip never settles in jsdom: render its content in place.
vi.mock("@sourceweft/ui-web/components/ui/tooltip", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@sourceweft/ui-web/components/ui/tooltip")
  >()),
  TooltipContent: ({ children }: { children?: ReactNode }) => (
    <div data-slot="tooltip-content">{children}</div>
  ),
}));

import {
  CatalogAiOverview,
  type CatalogAiOverviewContent,
  type CatalogAiOverviewProps,
} from "./catalog-ai-overview";
import {
  type IntlOptions,
  messages,
  mountWithIntl,
  unmountAll,
  withIntl,
} from "@/test/react";

let container: HTMLDivElement;
afterEach(async () => {
  await unmountAll();
});

type IntlMessages = IntlOptions["messages"];
const catalogs: Record<string, IntlMessages> = {
  en: messages,
  "zh-CN": zhCNMessages as IntlMessages,
  "zh-TW": zhTWMessages as IntlMessages,
};

// The catalogs' own strings, so the expected headings below are checked
// against what ships.
const cautionHeadings: Record<string, string> = {
  en: enMessages.market.overview.cautions,
  "zh-CN": zhCNMessages.market.overview.cautions,
  "zh-TW": zhTWMessages.market.overview.cautions,
};

const labels = {
  title: "AI-generated overview",
  whatItDoes: "What it does",
  whenToUse: "When to use it",
  requirements: "Requirements",
};
const overview: CatalogAiOverviewContent = {
  summary: "Searches a team's GitHub issues.",
  whatItDoes: "Lists, searches and comments on issues.",
  whenToUse: "When triaging a backlog.",
  requirements: "A GitHub token with repo scope.",
  cautions: "It can post comments as you.",
  suggestedCategories: ["developer-tools", "project-management"],
};

async function render(
  props: Partial<CatalogAiOverviewProps> = {},
  locale = "en",
) {
  ({ container } = await mountWithIntl(
    <CatalogAiOverview labels={labels} overview={overview} {...props} />,
    { locale, messages: catalogs[locale] },
  ));
  return container.querySelector<HTMLElement>(
    '[data-testid="catalog-ai-overview"]',
  );
}

function cautions() {
  return container.querySelector<HTMLElement>(
    '[data-testid="catalog-ai-overview-cautions"]',
  );
}

describe("CatalogAiOverview", () => {
  test("shows every field, each under its label, in order", async () => {
    const block = await render();
    expect(block?.querySelector("p")?.textContent).toBe(overview.summary);
    const rows = [...(block?.querySelectorAll("dl > div") ?? [])].map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent,
    ]);
    expect(rows).toEqual([
      ["What it does", overview.whatItDoes],
      ["When to use it", overview.whenToUse],
      ["Requirements", overview.requirements],
    ]);
    expect(cautions()?.textContent).toContain(overview.cautions);
    // Suggested categories are taxonomy slugs, shown by the entry's own
    // categories once applied, never here.
    expect(block?.textContent).not.toContain("developer-tools");
    expect(block?.textContent).not.toContain("project-management");
  });

  test("labels the block as AI-generated, by heading and by accessible name", async () => {
    const block = await render();
    expect(block?.tagName).toBe("SECTION");
    expect(block?.getAttribute("aria-label")).toBe("AI-generated overview");
    expect(block?.firstElementChild?.textContent).toBe("AI-generated overview");
  });

  test("explains where the overview came from only when given an explainer", async () => {
    await render({
      explainer: { label: "About this overview", text: "Written by AI." },
    });
    const trigger = container.querySelector(
      'button[aria-label="About this overview"]',
    );
    expect(trigger).not.toBeNull();
    expect(
      container.querySelector('[data-slot="tooltip-content"]')?.textContent,
    ).toBe("Written by AI.");

    await unmountAll();
    await render();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });

  test("shows cautions as a note under a heading, after the sections", async () => {
    const block = await render({ notice: "Shown in English." });
    const note = cautions();
    expect(note?.getAttribute("role")).toBe("note");
    expect(note?.querySelector('[data-slot="alert-title"]')?.textContent).toBe(
      "Before you install",
    );
    expect(
      note?.querySelector('[data-slot="alert-description"]')?.textContent,
    ).toBe("It can post comments as you.");
    // Not an alert: it is part of the page, not news to announce.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const children = [...(block?.children ?? [])];
    expect(children.indexOf(note!)).toBe(
      children.indexOf(block!.querySelector("dl")!) + 1,
    );
    expect(children.at(-1)?.textContent).toBe("Shown in English.");
  });

  test.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["blank", "  \n "],
  ])("shows no cautions when they are %s", async (_, value) => {
    const block = await render({ overview: { ...overview, cautions: value } });
    expect(cautions()).toBeNull();
    expect(block?.textContent).not.toContain("Before you install");
    expect(block?.querySelector('[role="note"]')).toBeNull();
  });

  test("renders model text as text: no markup, no markdown, no links", async () => {
    const html = "<img src=x onerror=alert(1)> **bold** [link](https://x.test)";
    const block = await render({
      overview: {
        summary: `<script>alert(1)</script>`,
        whatItDoes: html,
        whenToUse: "Line one\nLine two",
        requirements: "`pip install x`",
        cautions: `<a href="https://x.test">click</a>\n# Heading`,
      },
    });
    expect(container.querySelector("script, img, a, strong, h1, code")).toBe(
      null,
    );
    expect(block?.textContent).toContain("<script>alert(1)</script>");
    expect(block?.textContent).toContain(html);
    expect(cautions()?.textContent).toContain(
      `<a href="https://x.test">click</a>\n# Heading`,
    );
    // Line breaks the model wrote are kept.
    expect(
      [...container.querySelectorAll("dd")].every((dd) =>
        dd.className.includes("whitespace-pre-line"),
      ),
    ).toBe(true);
    expect(
      cautions()?.querySelector('[data-slot="alert-description"]')?.className,
    ).toContain("whitespace-pre-line");
  });

  test("leaves out empty sections", async () => {
    const block = await render({
      overview: {
        summary: "Only a summary.",
        whatItDoes: "",
        whenToUse: "   ",
        requirements: "\n",
      },
    });
    expect(block?.querySelector("dl")).toBeNull();
    expect(block?.textContent).toBe("AI-generated overviewOnly a summary.");
  });

  test("shows the notice and the provenance line only when given", async () => {
    const block = await render({
      notice: "Shown in English: no overview in your language yet.",
      meta: "deepseek-v4-flash · 22 Sep 2026",
    });
    const lines = [...(block?.querySelectorAll(":scope > p") ?? [])].map(
      (line) => line.textContent,
    );
    expect(lines).toEqual([
      overview.summary,
      "Shown in English: no overview in your language yet.",
      "deepseek-v4-flash · 22 Sep 2026",
    ]);

    await unmountAll();
    const bare = await render({ notice: null, meta: undefined });
    expect(bare?.querySelectorAll(":scope > p")).toHaveLength(1);
  });

  test("takes a test id and extra classes for where it is placed", async () => {
    ({ container } = await mountWithIntl(
      <CatalogAiOverview
        className="mb-0"
        data-testid="mcp-ai-overview"
        labels={labels}
        overview={overview}
      />,
    ));
    const block = container.querySelector('[data-testid="mcp-ai-overview"]');
    expect(block).not.toBeNull();
    expect(block?.className).toContain("mb-0");
    expect(block?.className).not.toContain("mb-4");
  });

  test.each([
    ["en", "Before you install"],
    ["zh-CN", "安装前请注意"],
    ["zh-TW", "安裝前請注意"],
  ])(
    "titles the cautions in the page's language (%s)",
    async (locale, heading) => {
      expect(cautionHeadings[locale]).toBe(heading);
      await render({}, locale);
      expect(
        cautions()?.querySelector('[data-slot="alert-title"]')?.textContent,
      ).toBe(heading);
      // Server rendering says the same.
      expect(
        renderToStaticMarkup(
          withIntl(<CatalogAiOverview labels={labels} overview={overview} />, {
            locale,
            messages: catalogs[locale],
          }),
        ),
      ).toContain(heading);
    },
  );
});
