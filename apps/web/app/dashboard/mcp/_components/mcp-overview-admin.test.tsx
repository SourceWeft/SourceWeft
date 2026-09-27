// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";

import enMessages from "@/messages/en.json";

const api = vi.hoisted(() => ({
  getMarketAdminMe: vi.fn(),
  getMcpOverviewAdmin: vi.fn(),
  regenerateMcpOverview: vi.fn(),
  setMcpOverviewHidden: vi.fn(),
}));
vi.mock("../../../../lib/mcp-ai-overview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/mcp-ai-overview")>()),
  ...api,
}));

import type {
  MarketMcpOverviewLocale,
  McpOverviewAdminState,
} from "@/lib/mcp-ai-overview";
import { mountWithIntl, unmountAll } from "@/test/react";

import { McpOverviewAdmin } from "./mcp-overview-admin";

const copy = enMessages.mcp.aiOverview.admin;
const IDENTIFIER = "io.github.o/weather";

let container: HTMLDivElement;
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
  vi.useRealTimers();
});

function state(
  patch: Partial<McpOverviewAdminState> = {},
  {
    hidden = false,
    locales = ["en", "zh-CN", "zh-TW"],
  }: { hidden?: boolean; locales?: MarketMcpOverviewLocale[] } = {},
): McpOverviewAdminState {
  return {
    entries: locales.map((locale) => ({
      locale,
      model: "deepseek-v4",
      hidden,
      generatedAt: "2026-09-27T00:00:00.000Z",
    })),
    analysis: { status: "ready", error: null },
    categoriesSource: "ai",
    eligible: true,
    systemModel: { ready: true, reason: null },
    ...patch,
  };
}

async function render() {
  ({ container } = await mountWithIntl(
    <McpOverviewAdmin identifier={IDENTIFIER} />,
  ));
}

const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );

test("renders nothing for someone who is not a market admin", async () => {
  api.getMarketAdminMe.mockResolvedValue(false);
  await render();
  expect(container.innerHTML).toBe("");
  expect(api.getMcpOverviewAdmin).not.toHaveBeenCalled();
});

test("shows each language's state, the analysis, the system model, the model and the time", async () => {
  api.getMarketAdminMe.mockResolvedValue(true);
  api.getMcpOverviewAdmin.mockResolvedValue(
    state({}, { locales: ["en", "zh-CN"] }),
  );
  await render();
  expect(api.getMcpOverviewAdmin).toHaveBeenCalledWith(IDENTIFIER);
  const list = container.querySelector(`ul[aria-label="${copy.locales}"]`);
  expect(
    [...(list?.querySelectorAll("li") ?? [])].map((li) => li.textContent),
  ).toEqual([
    `en${copy.visible}`,
    `zh-CN${copy.visible}`,
    `zh-TW${copy.missing}`,
  ]);
  const analysis = container.querySelector(
    '[data-testid="mcp-overview-analysis"]',
  );
  expect(analysis?.textContent).toContain(
    `${copy.analysisState}: ${copy.analysisStatuses.ready}`,
  );
  expect(analysis?.textContent).toContain(
    `${copy.categorySource}: ${copy.categorySources.ai}`,
  );
  expect(
    container.querySelector('[data-testid="mcp-overview-system-model"]')
      ?.textContent,
  ).toContain(`${copy.systemModel}${copy.systemModelReady}`);
  expect(container.textContent).toContain("deepseek-v4");
  expect(container.textContent).toContain(copy.generatedAt);
  expect(button(copy.hide)).toBeDefined();
  expect(button(copy.regenerate)?.disabled).toBe(false);
});

test("shows the analysis error and why the system model is not ready", async () => {
  api.getMarketAdminMe.mockResolvedValue(true);
  api.getMcpOverviewAdmin.mockResolvedValue(
    state({
      analysis: { status: "failed", error: "Model unavailable" },
      systemModel: { ready: false, reason: "SYSTEM_MODEL_API_KEY is not set" },
    }),
  );
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Model unavailable",
  );
  expect(container.textContent).toContain(copy.analysisStatuses.failed);
  const systemModel = container.querySelector(
    '[data-testid="mcp-overview-system-model"]',
  );
  expect(systemModel?.textContent).toContain(copy.systemModelNotReady);
  expect(systemModel?.textContent).toContain("SYSTEM_MODEL_API_KEY is not set");
  // Existing overviews are kept after a failure.
  expect(container.querySelectorAll("li")).toHaveLength(3);
});

test("regenerate queues and reloads; hide and show flip every language", async () => {
  api.getMarketAdminMe.mockResolvedValue(true);
  api.getMcpOverviewAdmin.mockResolvedValue(state());
  api.regenerateMcpOverview.mockResolvedValue({ queued: true });
  api.setMcpOverviewHidden.mockResolvedValue(undefined);
  await render();

  await act(async () => button(copy.regenerate)!.click());
  expect(api.regenerateMcpOverview).toHaveBeenCalledWith(IDENTIFIER);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    copy.regenerateQueued,
  );
  expect(api.getMcpOverviewAdmin).toHaveBeenCalledTimes(2);

  api.getMcpOverviewAdmin.mockResolvedValue(state({}, { hidden: true }));
  await act(async () => button(copy.hide)!.click());
  expect(api.setMcpOverviewHidden).toHaveBeenCalledWith(IDENTIFIER, true);
  expect(container.textContent).toContain(copy.hiddenDone);
  expect(
    [...container.querySelectorAll("li")].map((li) => li.textContent),
  ).toEqual([`en${copy.hidden}`, `zh-CN${copy.hidden}`, `zh-TW${copy.hidden}`]);

  api.getMcpOverviewAdmin.mockResolvedValue(state());
  await act(async () => button(copy.show)!.click());
  expect(api.setMcpOverviewHidden).toHaveBeenLastCalledWith(IDENTIFIER, false);
  expect(container.textContent).toContain(copy.shownDone);
});

test("says when a regeneration was not queued, and when an action fails", async () => {
  api.getMarketAdminMe.mockResolvedValue(true);
  api.getMcpOverviewAdmin.mockResolvedValue(state());
  api.regenerateMcpOverview.mockResolvedValueOnce({ queued: false });
  await render();
  await act(async () => button(copy.regenerate)!.click());
  expect(container.textContent).toContain(copy.regenerateNotQueued);

  api.regenerateMcpOverview.mockRejectedValueOnce(new Error("Unavailable"));
  await act(async () => button(copy.regenerate)!.click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    copy.failed,
  );
  expect(container.querySelectorAll("li")).toHaveLength(3);
});

test("a server overviews are not written for says so, with no Hide button", async () => {
  api.getMarketAdminMe.mockResolvedValue(true);
  api.getMcpOverviewAdmin.mockResolvedValue(
    state(
      { eligible: false, analysis: null, categoriesSource: null },
      { locales: [] },
    ),
  );
  await render();
  expect(container.textContent).toContain(copy.notEligible);
  expect(container.textContent).toContain(copy.analysisStatuses.missing);
  expect(container.textContent).toContain(copy.categorySources.none);
  expect(button(copy.hide)).toBeUndefined();
  expect(button(copy.regenerate)!.disabled).toBe(true);
});

test("an eligible server with no overview yet says so", async () => {
  api.getMarketAdminMe.mockResolvedValue(true);
  api.getMcpOverviewAdmin.mockResolvedValue(
    state({ analysis: null }, { locales: [] }),
  );
  await render();
  expect(container.textContent).toContain(copy.none);
  expect(button(copy.regenerate)!.disabled).toBe(false);
});

test("polls while an analysis runs, and allows Regenerate once it ends", async () => {
  vi.useFakeTimers();
  api.getMarketAdminMe.mockResolvedValue(true);
  api.getMcpOverviewAdmin.mockResolvedValue(
    state({ analysis: { status: "running", error: null } }),
  );
  await render();
  expect(container.textContent).toContain(copy.analysisStatuses.running);
  expect(button(copy.regenerate)!.disabled).toBe(true);

  api.getMcpOverviewAdmin.mockResolvedValue(state());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(api.getMcpOverviewAdmin).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain(copy.analysisStatuses.ready);
  expect(button(copy.regenerate)!.disabled).toBe(false);
});
