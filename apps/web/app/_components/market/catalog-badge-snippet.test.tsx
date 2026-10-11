// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import zhCN from "@/messages/zh-CN.json";
import { button, click, flush, mountWithIntl, unmountAll } from "@/test/react";

const analytics = vi.hoisted(() => ({ trackBadgeSnippetCopied: vi.fn() }));
vi.mock("../../../lib/analytics-events", () => analytics);

import { CatalogBadgeSnippet } from "./catalog-badge-snippet";

const writeText = vi.fn();
const MCP_MARKDOWN =
  "[![Listed on SourceWeft](https://sourceweft.test/badge/mcp/io.github.o%2Fweather.svg)](https://sourceweft.test/mcp/io.github.o%2Fweather?utm_source=readme&utm_medium=badge)";
const MCP_HTML =
  '<a href="https://sourceweft.test/mcp/io.github.o%2Fweather?utm_source=readme&amp;utm_medium=badge"><img src="https://sourceweft.test/badge/mcp/io.github.o%2Fweather.svg" alt="Listed on SourceWeft" height="20"></a>';

beforeEach(() => {
  analytics.trackBadgeSnippetCopied.mockReset();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});
afterEach(unmountAll);

const snippet = (container: HTMLElement) =>
  container.querySelector('[role="tabpanel"] code')?.textContent;
const tab = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (node) => node.textContent === label,
  )!;

test("folds behind a summary on a public page, with a live preview of the real badge", async () => {
  const { container } = await mountWithIntl(
    <CatalogBadgeSnippet
      display="disclosure"
      siteUrl="https://sourceweft.test/"
      surface="mcp_detail"
      target={{ kind: "mcp", key: "io.github.o/weather" }}
    />,
  );
  const details = container.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")?.textContent).toBe(
    "Add a badge to your README",
  );
  expect(details.textContent).toContain(
    "Show readers this MCP server is listed on SourceWeft.",
  );
  const preview = details.querySelector("img")!;
  expect(preview.getAttribute("src")).toBe(
    "https://sourceweft.test/badge/mcp/io.github.o%2Fweather.svg",
  );
  expect(preview.getAttribute("alt")).toBe(
    "Preview of the “Listed on SourceWeft” badge",
  );
  expect(preview.getAttribute("loading")).toBe("lazy");
  expect(preview.getAttribute("height")).toBe("20");
  expect(snippet(container)).toBe(MCP_MARKDOWN);
});

test("switches between the Markdown and HTML snippets", async () => {
  const { container } = await mountWithIntl(
    <CatalogBadgeSnippet
      display="disclosure"
      siteUrl="https://sourceweft.test"
      surface="mcp_detail"
      target={{ kind: "mcp", key: "io.github.o/weather" }}
    />,
  );
  expect(tab(container, "Markdown").getAttribute("aria-selected")).toBe("true");
  await click(tab(container, "HTML"));
  expect(tab(container, "HTML").getAttribute("aria-selected")).toBe("true");
  expect(tab(container, "Markdown").getAttribute("aria-selected")).toBe(
    "false",
  );
  expect(snippet(container)).toBe(MCP_HTML);
});

test("copies the whole snippet shown and reports which one, from where", async () => {
  const { container } = await mountWithIntl(
    <CatalogBadgeSnippet
      display="disclosure"
      siteUrl="https://sourceweft.test"
      surface="mcp_detail"
      target={{ kind: "mcp", key: "io.github.o/weather" }}
    />,
  );
  // The same button, though it says "Copied" for a moment after each copy.
  const copy = button("Copy", container);
  await click(copy);
  await flush();
  expect(writeText).toHaveBeenLastCalledWith(MCP_MARKDOWN);
  expect(analytics.trackBadgeSnippetCopied).toHaveBeenLastCalledWith({
    kind: "mcp",
    method: "markdown",
    surface: "mcp_detail",
  });

  await click(tab(container, "HTML"));
  await click(copy);
  await flush();
  expect(writeText).toHaveBeenLastCalledWith(MCP_HTML);
  expect(analytics.trackBadgeSnippetCopied).toHaveBeenLastCalledWith({
    kind: "mcp",
    method: "html",
    surface: "mcp_detail",
  });
  expect(analytics.trackBadgeSnippetCopied).toHaveBeenCalledTimes(2);
});

test("reports nothing when the clipboard refuses", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  const { container } = await mountWithIntl(
    <CatalogBadgeSnippet
      display="disclosure"
      siteUrl="https://sourceweft.test"
      surface="skill_detail"
      target={{ kind: "skill", key: "gh-ada-skills-pdf" }}
    />,
  );
  await click(button("Copy", container));
  await flush(2);
  expect(analytics.trackBadgeSnippetCopied).not.toHaveBeenCalled();
});

test("speaks the page's language, while the snippet stays English and unprefixed", async () => {
  const { container } = await mountWithIntl(
    <CatalogBadgeSnippet
      display="disclosure"
      siteUrl="https://sourceweft.test"
      surface="skill_detail"
      target={{ kind: "skill", key: "gh-ada-skills-pdf" }}
    />,
    { locale: "zh-CN", messages: zhCN },
  );
  expect(container.querySelector("summary")?.textContent).toBe(
    "在 README 中添加徽章",
  );
  expect(container.textContent).toContain("该技能已收录于 SourceWeft");
  expect(button("复制", container)).toBeTruthy();
  expect(snippet(container)).toBe(
    "[![Listed on SourceWeft](https://sourceweft.test/badge/skills/gh-ada-skills-pdf.svg)](https://sourceweft.test/skills/gh-ada-skills-pdf?utm_source=readme&utm_medium=badge)",
  );

  writeText.mockResolvedValue(undefined);
  await click(button("复制", container));
  await flush();
  expect(button("已复制", container)).toBeTruthy();
});

test("shows the snippet at once, under the caller's lead, for an author's moment", async () => {
  const { container } = await mountWithIntl(
    <CatalogBadgeSnippet
      display="inline"
      intro="Your skill is listed."
      siteUrl="https://sourceweft.test"
      surface="skill_owner"
      target={{ kind: "skill", key: "gh-ada-skills-pdf" }}
    />,
  );
  expect(container.querySelector("details")).toBeNull();
  expect(container.textContent).toContain("Your skill is listed.");
  expect(container.textContent).not.toContain("Add a badge to your README");
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "https://sourceweft.test/badge/skills/gh-ada-skills-pdf.svg",
  );

  await click(button("Copy", container));
  await flush();
  expect(analytics.trackBadgeSnippetCopied).toHaveBeenLastCalledWith({
    kind: "skill",
    method: "markdown",
    surface: "skill_owner",
  });
});
