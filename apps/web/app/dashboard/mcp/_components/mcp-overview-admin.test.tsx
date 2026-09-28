// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  getMcpOverviewAdminResponseSchema,
  type GetMcpOverviewAdminResponse,
} from "@sourceweft/contracts";

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

import type { MarketMcpLocale } from "@/lib/mcp-ai-overview";
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

const analysis = {
  status: "ready",
  error: null,
  force: false,
  promptVersion: "mcp-overview-v1",
  taxonomyVersion: "t1",
  classification: null,
  updatedAt: "2026-09-27T00:00:00.000Z",
} as const;

const systemModel = {
  enabled: true,
  configured: true,
  ready: true,
  provider: "openrouter",
  model: "deepseek/deepseek-v4",
  problems: [],
  reason: null,
};

/** An admin answer, checked against the contract. */
function state(
  patch: Partial<GetMcpOverviewAdminResponse> = {},
  {
    hidden = false,
    locales = ["en", "zh-CN", "zh-TW"],
    current = true,
  }: { hidden?: boolean; locales?: MarketMcpLocale[]; current?: boolean } = {},
): GetMcpOverviewAdminResponse {
  return getMcpOverviewAdminResponseSchema.parse({
    identifier: IDENTIFIER,
    serverId: "server-1",
    versionId: "version-1",
    version: "1.0.0",
    eligible: true,
    readmeStatus: "ok",
    inputSha256: "sha",
    skipReason: null,
    categoriesSource: "ai",
    analysis,
    overviews: locales.map((locale) => ({
      locale,
      overview: {
        summary: "s",
        whatItDoes: "w",
        whenToUse: "u",
        requirements: "",
        cautions: null,
        suggestedCategories: ["weather"],
      },
      model: "deepseek-v4",
      hidden,
      generatedAt: "2026-09-27T00:00:00.000Z",
      inputSha256: "sha",
      current,
    })),
    systemModel,
    ...patch,
  });
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

const localeRows = () =>
  [...container.querySelectorAll("li")].map((li) => li.textContent);

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
  const analysisBlock = container.querySelector(
    '[data-testid="mcp-overview-analysis"]',
  );
  expect(analysisBlock?.textContent).toContain(
    `${copy.analysisState}: ${copy.analysisStatuses.ready}`,
  );
  expect(analysisBlock?.textContent).toContain(
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

test("marks an overview written from input the version no longer has", async () => {
  api.getMarketAdminMe.mockResolvedValue(true);
  api.getMcpOverviewAdmin.mockResolvedValue(state({}, { current: false }));
  await render();
  expect(localeRows()).toEqual([
    `en${copy.stale}${copy.visible}`,
    `zh-CN${copy.stale}${copy.visible}`,
    `zh-TW${copy.stale}${copy.visible}`,
  ]);
});

test("shows the analysis error, its rationale and evidence, and why the system model is not ready", async () => {
  api.getMarketAdminMe.mockResolvedValue(true);
  api.getMcpOverviewAdmin.mockResolvedValue(
    state({
      analysis: {
        ...analysis,
        status: "failed",
        error: "Model unavailable",
        classification: {
          status: "needs-review",
          categories: [{ slug: "weather", evidence: "Forecasts for any city" }],
          rationale: "Only one tool is described",
        },
      },
      systemModel: {
        ...systemModel,
        ready: false,
        problems: ["api_key_unset"],
        reason: "SYSTEM_MODEL_API_KEY is not set.",
      },
    }),
  );
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Model unavailable",
  );
  expect(container.textContent).toContain(copy.analysisStatuses.failed);
  expect(container.textContent).toContain(
    `${copy.rationale}: Only one tool is described`,
  );
  expect(container.textContent).toContain(
    `${copy.evidence}: weather: Forecasts for any city`,
  );
  const systemModelBlock = container.querySelector(
    '[data-testid="mcp-overview-system-model"]',
  );
  expect(systemModelBlock?.textContent).toContain(copy.systemModelNotReady);
  expect(systemModelBlock?.textContent).toContain(
    "SYSTEM_MODEL_API_KEY is not set.",
  );
  // Existing overviews are kept after a failure.
  expect(container.querySelectorAll("li")).toHaveLength(3);
});

test("regenerate queues and reloads; hide and show flip every language", async () => {
  api.getMarketAdminMe.mockResolvedValue(true);
  api.getMcpOverviewAdmin.mockResolvedValue(state());
  api.regenerateMcpOverview.mockResolvedValue({
    identifier: IDENTIFIER,
    versionId: "version-1",
    queued: true,
  });
  api.setMcpOverviewHidden.mockResolvedValue({
    identifier: IDENTIFIER,
    versionId: "version-1",
    hidden: true,
    updated: 3,
  });
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
  expect(localeRows()).toEqual([
    `en${copy.hidden}`,
    `zh-CN${copy.hidden}`,
    `zh-TW${copy.hidden}`,
  ]);

  api.getMcpOverviewAdmin.mockResolvedValue(state());
  await act(async () => button(copy.show)!.click());
  expect(api.setMcpOverviewHidden).toHaveBeenLastCalledWith(IDENTIFIER, false);
  expect(container.textContent).toContain(copy.shownDone);
});

test("says when a regeneration was not queued, and when an action fails", async () => {
  api.getMarketAdminMe.mockResolvedValue(true);
  api.getMcpOverviewAdmin.mockResolvedValue(state());
  api.regenerateMcpOverview.mockResolvedValueOnce({
    identifier: IDENTIFIER,
    versionId: "version-1",
    queued: false,
  });
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

test("a server overviews are not written for says why, with no Hide button", async () => {
  api.getMarketAdminMe.mockResolvedValue(true);
  api.getMcpOverviewAdmin.mockResolvedValue(
    state(
      {
        eligible: false,
        analysis: null,
        categoriesSource: "auto",
        skipReason: "not-eligible",
      },
      { locales: [] },
    ),
  );
  await render();
  expect(container.textContent).toContain(copy.skipReasons["not-eligible"]);
  expect(container.textContent).toContain(copy.analysisStatuses.missing);
  expect(container.textContent).toContain(copy.categorySources.auto);
  expect(button(copy.hide)).toBeUndefined();
  expect(button(copy.regenerate)!.disabled).toBe(true);
});

test("says when the README is still being read, or an unknown reason as the API names it", async () => {
  api.getMarketAdminMe.mockResolvedValue(true);
  api.getMcpOverviewAdmin.mockResolvedValue(
    state({ analysis: null, skipReason: "readme-pending" }, { locales: [] }),
  );
  await render();
  expect(container.textContent).toContain(copy.skipReasons["readme-pending"]);
  await unmountAll();

  api.getMcpOverviewAdmin.mockResolvedValue(
    state({ analysis: null, skipReason: "something-new" }, { locales: [] }),
  );
  await render();
  expect(container.textContent).toContain("something-new");
});

test("a server with no published version says so, with no actions", async () => {
  api.getMarketAdminMe.mockResolvedValue(true);
  api.getMcpOverviewAdmin.mockResolvedValue(
    state(
      {
        versionId: null,
        version: null,
        eligible: false,
        readmeStatus: null,
        inputSha256: null,
        skipReason: "not-eligible",
        analysis: null,
      },
      { locales: [] },
    ),
  );
  await render();
  expect(container.textContent).toContain(copy.noVersion);
  expect(button(copy.regenerate)).toBeUndefined();
  expect(button(copy.hide)).toBeUndefined();
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
    state({ analysis: { ...analysis, status: "running" } }),
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
