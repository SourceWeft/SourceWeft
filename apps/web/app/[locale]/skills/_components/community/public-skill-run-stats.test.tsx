import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ getPublicSkillRunStats: vi.fn() }));
vi.mock("../../../../../lib/public-skill-run-stats", () => api);

import { PublicSkillRunStats } from "./public-skill-run-stats";
import {
  formatPublicSuccessRate,
  publicRunStatsSentence,
  PublicSkillRunStatsPanel,
} from "./public-skill-run-stats-view";

const stats = {
  available: true as const,
  runs: 1240,
  successRate: 0.92,
  workspaces: 8,
  topErrors: [
    {
      errorClass: "missing_dependency" as const,
      subject: "pptxgenjs",
      count: 6,
    },
  ],
  windowDays: 30 as const,
};

beforeEach(() => {
  api.getPublicSkillRunStats.mockReset();
});

describe("publicRunStatsSentence", () => {
  test("en", () => {
    expect(publicRunStatsSentence(stats, "en")).toBe(
      "Ran 1,240 times in SourceWeft sandboxes in the last 30 days · 92% succeeded · Common issue: missing pptxgenjs",
    );
  });

  test("zh-CN", () => {
    expect(publicRunStatsSentence(stats, "zh-CN")).toBe(
      "近 30 天在 SourceWeft 沙箱中运行 1,240 次 · 成功率 92% · 常见问题：缺少 pptxgenjs",
    );
  });

  test("zh-TW, without a named dependency", () => {
    expect(
      publicRunStatsSentence(
        {
          ...stats,
          topErrors: [
            { errorClass: "missing_dependency", subject: null, count: 1 },
          ],
        },
        "zh-TW",
      ),
    ).toContain("常見問題：缺少相依套件");
  });

  test("one run, no issue", () => {
    expect(
      publicRunStatsSentence(
        { ...stats, runs: 1, successRate: 1, topErrors: [] },
        "en",
      ),
    ).toBe(
      "Ran 1 time in SourceWeft sandboxes in the last 30 days · 100% succeeded",
    );
  });

  test.each([
    ["timeout", "timed out"],
    ["permission", "permission denied"],
    ["other", "other errors"],
  ] as const)("%s → %s", (errorClass, label) => {
    expect(
      publicRunStatsSentence(
        { ...stats, topErrors: [{ errorClass, subject: null, count: 1 }] },
        "en",
      ),
    ).toContain(`Common issue: ${label}`);
  });

  test.each([
    [1, "100%"],
    [0.999, "99%"],
    [0.004, "1%"],
    [0, "0%"],
  ])("success rate %d → %s", (rate, text) => {
    expect(formatPublicSuccessRate(rate, "en")).toBe(text);
  });
});

describe("PublicSkillRunStats", () => {
  test("renders the panel when the stats are available", async () => {
    api.getPublicSkillRunStats.mockResolvedValue(stats);
    const html = renderToStaticMarkup(
      await PublicSkillRunStats({
        slug: "deck-builder",
        signedIn: false,
        locale: "en",
      }),
    );
    expect(api.getPublicSkillRunStats).toHaveBeenCalledWith("deck-builder");
    expect(html).toContain("Sandbox runs");
    expect(html).toContain("92% succeeded");
    expect(html).not.toContain("workspaces");
  });

  test("renders nothing otherwise", async () => {
    api.getPublicSkillRunStats.mockResolvedValue(null);
    expect(
      await PublicSkillRunStats({
        slug: "deck-builder",
        signedIn: true,
        locale: "zh-CN",
      }),
    ).toBeNull();
  });

  test("the panel alone", () => {
    const html = renderToStaticMarkup(
      <PublicSkillRunStatsPanel locale="zh-CN" stats={stats} />,
    );
    expect(html).toContain("沙箱运行");
    expect(html).toContain("rounded-xl");
  });
});
