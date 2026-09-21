// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";

const api = vi.hoisted(() => ({ getSkillAiOverview: vi.fn() }));
vi.mock("../../../../../lib/skill-overviews", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../../lib/skill-overviews")
  >()),
  getSkillAiOverview: api.getSkillAiOverview,
}));

import { SkillAiOverview } from "./skill-ai-overview";
import { SkillAiOverviewView } from "./skill-ai-overview-view";
import { overviewLocale } from "../../../../../lib/skill-overviews";
import messages from "../../../../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.resetAllMocks();
});

const overview = {
  summary: "Fills PDF forms.",
  whatItDoes: "Reads a PDF form and fills its fields.",
  whenToUse: "When a form arrives.",
  requirements: "",
  locale: "en" as const,
  generatedAt: "2026-09-22T00:00:00.000Z",
};
const slot = {
  skillId: "skill_1",
  catalogId: "cat_1",
  slug: "gh-acme-skills-pdf",
  workspaceId: "ws_1",
};

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

test("the view renders the overview's sections as plain text, labelled as AI-generated", async () => {
  await render(
    <SkillAiOverviewView
      overview={{
        ...overview,
        whatItDoes:
          "<img src=x onerror=alert(1)> **bold** [link](https://x.test)",
        requirements: "Python 3",
      }}
    />,
  );
  const block = container.querySelector('[data-testid="skill-ai-overview"]');
  expect(block?.textContent).toContain("AI-generated overview");
  expect(block?.textContent).toContain("Fills PDF forms.");
  expect(block?.textContent).toContain("When to use it");
  expect(block?.textContent).toContain("Python 3");
  // Untrusted text stays text: no element, no link, no markdown rendering.
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("a")).toBeNull();
  expect(block?.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(block?.textContent).toContain("**bold**");
  expect(
    container.querySelector('button[aria-label="About this overview"]'),
  ).not.toBeNull();
});

test("an empty section is left out, and a fallback to English is noted", async () => {
  await render(
    <SkillAiOverviewView overview={overview} requestedLocale="zh-TW" />,
  );
  expect(container.textContent).not.toContain("Requirements");
  expect(container.textContent).toContain("Shown in English");
});

test("the dashboard block asks for the viewer's locale", async () => {
  api.getSkillAiOverview.mockResolvedValue({ ...overview, locale: "zh-CN" });
  await render(<SkillAiOverview {...slot} />, "zh-CN");
  expect(api.getSkillAiOverview).toHaveBeenCalledWith(
    "gh-acme-skills-pdf",
    "zh-CN",
  );
  expect(container.textContent).toContain("Fills PDF forms.");
  expect(container.textContent).not.toContain("Shown in English");
});

test("nothing renders when there is no overview (e.g. a restricted skill) or the read fails", async () => {
  api.getSkillAiOverview.mockResolvedValue(null);
  await render(<SkillAiOverview {...slot} />);
  expect(container.innerHTML).toBe("");

  act(() => root.unmount());
  container.remove();
  api.getSkillAiOverview.mockRejectedValue(new Error("down"));
  await render(<SkillAiOverview {...slot} />);
  expect(container.innerHTML).toBe("");
});

test("an app locale overviews are not written in reads English", () => {
  expect(overviewLocale("zh-TW")).toBe("zh-TW");
  expect(overviewLocale("fr")).toBe("en");
  expect(overviewLocale(undefined)).toBe("en");
});
