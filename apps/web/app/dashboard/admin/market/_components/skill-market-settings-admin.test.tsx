// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSkillAnalysisPreview: vi.fn(),
  queueSkillAnalysisBatch: vi.fn(),
  getSkillOverviewStatus: vi.fn(),
}));
vi.mock("../../../../../lib/skill-overviews", () => api);

import { SkillMarketSettingsAdmin } from "./skill-market-settings-admin";
import { button, mountWithIntl, unmountAll } from "@/test/react";

let container: HTMLDivElement;
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});

const readySystemModel = {
  enabled: true,
  configured: true,
  ready: true,
  provider: "openrouter",
  model: "deepseek/deepseek-v4.1-flash",
  problems: [],
  reason: null,
};

const status = {
  systemModel: readySystemModel,
  eligible: 12,
  withOverview: 9,
  missing: 3,
  hidden: 1,
};

async function render() {
  ({ container } = await mountWithIntl(<SkillMarketSettingsAdmin />));
}

test("a ready system model is shown with its Provider and model, with the coverage counts", async () => {
  api.getSkillOverviewStatus.mockResolvedValue(status);
  await render();
  const model = container.querySelector('[data-testid="system-model-status"]');
  expect(model?.textContent).toContain("System model");
  expect(model?.textContent).toContain("Ready");
  expect(model?.textContent).toContain(
    "openrouter · deepseek/deepseek-v4.1-flash",
  );
  expect(model?.querySelector("ul")).toBeNull();
  const counts = container.querySelector('[data-testid="overview-status"]');
  expect(counts?.textContent).toContain("Eligible skills12");
  expect(counts?.textContent).toContain("Missing3");
  // Nothing about billing a team is left.
  expect(container.querySelector("form")).toBeNull();
  expect(container.textContent).not.toMatch(/billed to the team|Billed/);
});

test("a system model that is not ready lists exactly what is missing", async () => {
  api.getSkillOverviewStatus.mockResolvedValue({
    ...status,
    systemModel: {
      enabled: false,
      configured: false,
      ready: false,
      provider: "atlascloud",
      model: null,
      problems: [
        "disabled",
        "provider_not_found",
        "api_key_unset",
        "model_unset",
      ],
      reason: "…",
    },
  });
  await render();
  const model = container.querySelector('[data-testid="system-model-status"]');
  expect(model?.textContent).toContain("Not ready");
  expect(model?.textContent).toContain("No Provider or model is set.");
  const problems = [...(model?.querySelectorAll("li") ?? [])].map(
    (item) => item.textContent,
  );
  expect(problems).toEqual([
    "SYSTEM_MODEL_ENABLED is not true.",
    "Provider “atlascloud” is not in the global model gateway configuration.",
    "SYSTEM_MODEL_API_KEY is not set.",
    "SYSTEM_MODEL_NAME is not set.",
  ]);
});

test("a failed status load is reported", async () => {
  api.getSkillOverviewStatus.mockRejectedValue(new Error("offline"));
  await render();
  expect(container.textContent).toContain(
    "Could not load the overview settings.",
  );
  expect(
    container.querySelector('[data-testid="system-model-status"]'),
  ).toBeNull();
});

test("preview preserves manual categories and queues only eligible reviewed batch IDs", async () => {
  api.getSkillOverviewStatus.mockResolvedValue(status);
  const item = {
    skillId: "s1",
    skillVersionId: "v1",
    name: "PDF skill",
    categoriesSource: "auto",
    status: "legacy",
    categories: ["development"],
    suggestedCategories: ["documents"],
    error: null,
    stale: true,
  };
  api.getSkillAnalysisPreview.mockResolvedValue({
    qualityApproved: true,
    items: [
      item,
      { ...item, skillVersionId: "manual", categoriesSource: "admin" },
      { ...item, skillVersionId: "running", status: "running" },
    ],
    nextCursor: "next",
  });
  api.queueSkillAnalysisBatch.mockResolvedValue({ queued: 1, skipped: 0 });
  await render();
  expect(api.getSkillAnalysisPreview).not.toHaveBeenCalled();
  await act(async () => button("Preview analysis batch").click());
  expect(container.textContent).toContain("Current categories: development");
  expect(container.textContent).toContain("AI suggestions: documents");
  await act(async () => button("Generate / retry this batch (1)").click());
  expect(api.queueSkillAnalysisBatch).toHaveBeenCalledWith(["v1"]);
  expect(container.textContent).toContain("Queued 1; skipped 0.");
  await act(async () => button("Next batch").click());
  expect(api.getSkillAnalysisPreview).toHaveBeenLastCalledWith("next");
});

test("quality approval is required for bulk migration", async () => {
  api.getSkillOverviewStatus.mockResolvedValue(status);
  api.getSkillAnalysisPreview.mockResolvedValue({
    qualityApproved: false,
    items: [
      {
        skillId: "s",
        skillVersionId: "v",
        name: "Skill",
        categoriesSource: "auto",
        status: "legacy",
        categories: [],
        suggestedCategories: [],
        error: null,
        stale: true,
      },
    ],
    nextCursor: null,
  });
  await render();
  await act(async () => button("Preview analysis batch").click());
  expect(button("Generate / retry this batch (1)").disabled).toBe(true);
  expect(container.textContent).toContain(
    "reviewed accuracy evaluation passes",
  );
  expect(api.queueSkillAnalysisBatch).not.toHaveBeenCalled();
});

test("a delayed poll cannot replace the next preview page", async () => {
  vi.useFakeTimers();
  try {
    api.getSkillOverviewStatus.mockResolvedValue(status);
    const row = {
      skillId: "a",
      skillVersionId: "va",
      name: "Page A",
      categoriesSource: null,
      status: "running",
      categories: [],
      suggestedCategories: [],
      error: null,
      stale: true,
    };
    const pageA = {
      qualityApproved: false,
      items: [row],
      nextCursor: "page-b",
    };
    const pageB = {
      qualityApproved: false,
      items: [
        {
          ...row,
          skillId: "b",
          skillVersionId: "vb",
          name: "Page B",
          status: "missing",
        },
      ],
      nextCursor: null,
    };
    let resolvePoll!: (value: typeof pageA) => void;
    api.getSkillAnalysisPreview
      .mockResolvedValueOnce(pageA)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePoll = resolve;
          }),
      )
      .mockResolvedValueOnce(pageB);
    await render();
    await act(async () => button("Preview analysis batch").click());
    await act(async () => vi.advanceTimersByTime(3000));
    await act(async () => button("Next batch").click());
    expect(container.textContent).toContain("Page B");
    await act(async () => resolvePoll(pageA));
    expect(container.textContent).toContain("Page B");
    expect(container.textContent).not.toContain("Page A");
  } finally {
    vi.useRealTimers();
  }
});
