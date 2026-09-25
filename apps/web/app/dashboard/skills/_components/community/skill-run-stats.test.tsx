// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SkillRunStatsFull } from "@sourceweft/contracts";
import { createTranslator, type useTranslations } from "next-intl";
import {
  formatSuccessRate,
  skillRunStatsSentence,
  SkillRunStatsDetails,
  SkillRunStatsSummary,
  type AvailableSkillRunStats,
} from "./skill-run-stats-view";
import messages from "../../../../../messages/en.json";
import { mountWithIntl, unmountAll } from "@/test/react";

const t = createTranslator({
  locale: "en",
  messages,
  namespace: "dashboardSkillRunStats",
}) as unknown as ReturnType<typeof useTranslations>;

const api = vi.hoisted(() => ({ loadSkillRunStatsView: vi.fn() }));
vi.mock("../../../../../lib/skill-run-stats", () => api);

import { SkillRunStats } from "./skill-run-stats";

const available: AvailableSkillRunStats = {
  available: true,
  runs: 124,
  successRate: 0.92,
  workspaces: 8,
  topErrors: [
    { errorClass: "missing_dependency", subject: "pptxgenjs", count: 6 },
    { errorClass: "timeout", subject: null, count: 2 },
  ],
  windowDays: 30,
};
const full: SkillRunStatsFull = {
  skillId: "skill_1",
  runs: 3,
  successes: 2,
  successRate: 2 / 3,
  workspaces: 1,
  topErrors: [
    { errorClass: "permission", subject: null, count: 1 },
    { errorClass: "missing_dependency", subject: null, count: 1 },
  ],
  windowDays: 30,
  publiclyVisible: false,
  computedAt: "2026-09-22T00:00:00.000Z",
};

let container: HTMLDivElement;

beforeEach(() => {
  api.loadSkillRunStatsView.mockReset();
});
afterEach(unmountAll);

async function render(node: ReactNode) {
  ({ container } = await mountWithIntl(node));
}

describe("formatting", () => {
  test("the sentence", () => {
    expect(skillRunStatsSentence(available, t, "en")).toBe(
      "Ran 124 times in SourceWeft sandboxes in the last 30 days · 92% succeeded · Common issue: missing pptxgenjs",
    );
  });

  test("no issue, one run", () => {
    expect(
      skillRunStatsSentence(
        { ...available, runs: 1, successRate: 1, topErrors: [] },
        t,
        "en",
      ),
    ).toBe(
      "Ran 1 time in SourceWeft sandboxes in the last 30 days · 100% succeeded",
    );
  });

  test.each([
    [1, "100%"],
    [0.999, "99%"],
    [0.92, "92%"],
    [0.004, "1%"],
    [0, "0%"],
  ])("success rate %d → %s", (rate, text) => {
    expect(formatSuccessRate(rate, "en")).toBe(text);
  });
});

describe("presentation", () => {
  test("the public line", async () => {
    await render(<SkillRunStatsSummary stats={available} />);
    expect(container.textContent).toContain("Sandbox runs");
    expect(container.textContent).toContain("Common issue: missing pptxgenjs");
    expect(container.textContent).not.toContain("market admins");
  });

  test("the full numbers, marked private", async () => {
    await render(<SkillRunStatsDetails stats={full} />);
    const text = container.textContent ?? "";
    expect(text).toContain("2 of 3 (67%)");
    expect(text).toContain("Workspaces1");
    expect(text).toContain("Hidden until 10 runs from 3 workspaces");
    expect(text).toContain("permission denied");
    expect(text).toContain("a missing dependency");
    expect(text).toContain("Only you and market admins see this.");
  });

  test("full with no runs", async () => {
    await render(
      <SkillRunStatsDetails
        stats={{
          ...full,
          runs: 0,
          successes: 0,
          successRate: null,
          topErrors: [],
          computedAt: null,
        }}
      />,
    );
    expect(container.textContent).toContain(
      "No sandbox runs in the last 30 days.",
    );
    expect(container.textContent).toContain("Only you and market admins");
  });
});

describe("SkillRunStats", () => {
  const props = {
    skillId: "skill_1",
    catalogId: "cat_1",
    slug: "deck-builder",
    workspaceId: "ws-1",
  };

  test("the author or an admin sees the full numbers", async () => {
    api.loadSkillRunStatsView.mockResolvedValue({ kind: "full", stats: full });
    await render(<SkillRunStats {...props} />);
    expect(api.loadSkillRunStatsView).toHaveBeenCalledWith("deck-builder");
    expect(container.textContent).toContain("Only you and market admins");
  });

  test("anyone else sees the public line", async () => {
    api.loadSkillRunStatsView.mockResolvedValue({
      kind: "public",
      stats: available,
    });
    await render(<SkillRunStats {...props} />);
    expect(container.textContent).toContain("92% succeeded");
    expect(container.textContent).not.toContain("market admins");
  });

  test.each([
    ["unavailable", () => Promise.resolve({ kind: "none" })],
    ["a failed request", () => Promise.reject(new Error("down"))],
  ])("renders nothing when %s", async (_label, answer) => {
    api.loadSkillRunStatsView.mockImplementation(answer);
    await render(<SkillRunStats {...props} />);
    expect(container.innerHTML).toBe("");
  });
});
