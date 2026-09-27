// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";

import zhCNMessages from "@/messages/zh-CN.json";
import zhTWMessages from "@/messages/zh-TW.json";

const api = vi.hoisted(() => ({ getMcpAiOverview: vi.fn() }));
vi.mock("../../../../lib/mcp-ai-overview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/mcp-ai-overview")>()),
  getMcpAiOverview: api.getMcpAiOverview,
}));

import { type IntlOptions, mountWithIntl, unmountAll } from "@/test/react";

import { McpAiOverview } from "./mcp-ai-overview";

type IntlMessages = IntlOptions["messages"];

let container: HTMLDivElement;
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});

const IDENTIFIER = "io.github.o/weather";
const overview = {
  summary: "Forecasts for any city.",
  whatItDoes: "Looks up forecasts and alerts.",
  whenToUse: "Before a trip.",
  requirements: "",
  cautions: null,
  locale: "en" as const,
  generatedAt: "2026-09-27T00:00:00.000Z",
};

async function render(locale = "en", messages?: IntlMessages) {
  ({ container } = await mountWithIntl(
    <McpAiOverview identifier={IDENTIFIER} />,
    { locale, messages },
  ));
  return container.querySelector('[data-testid="mcp-ai-overview"]');
}

test("asks for the viewer's language and shows the overview in it", async () => {
  api.getMcpAiOverview.mockResolvedValue({ ...overview, locale: "zh-CN" });
  const block = await render("zh-CN", zhCNMessages as IntlMessages);
  expect(api.getMcpAiOverview).toHaveBeenCalledWith(IDENTIFIER, "zh-CN");
  expect(block?.textContent).toContain(zhCNMessages.mcp.aiOverview.title);
  expect(block?.textContent).toContain("Forecasts for any city.");
  expect(block?.textContent).not.toContain(
    zhCNMessages.mcp.aiOverview.englishFallback,
  );
});

test("notes an English fallback", async () => {
  api.getMcpAiOverview.mockResolvedValue(overview);
  const block = await render("zh-TW", zhTWMessages as IntlMessages);
  expect(api.getMcpAiOverview).toHaveBeenCalledWith(IDENTIFIER, "zh-TW");
  expect(block?.textContent).toContain(
    zhTWMessages.mcp.aiOverview.englishFallback,
  );
});

test("asks in English for a language overviews are not written in", async () => {
  api.getMcpAiOverview.mockResolvedValue(overview);
  await render("fr");
  expect(api.getMcpAiOverview).toHaveBeenCalledWith(IDENTIFIER, "en");
});

test("shows nothing without an overview, or when the read fails", async () => {
  api.getMcpAiOverview.mockResolvedValue(null);
  await render();
  expect(container.innerHTML).toBe("");
  await unmountAll();

  api.getMcpAiOverview.mockRejectedValue(new Error("down"));
  await render();
  expect(container.innerHTML).toBe("");
});
