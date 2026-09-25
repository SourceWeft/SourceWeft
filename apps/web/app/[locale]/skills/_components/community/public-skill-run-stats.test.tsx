import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import zhCNMessages from "../../../../../messages/zh-CN.json";

const api = vi.hoisted(() => ({ getPublicSkillRunStats: vi.fn() }));
vi.mock("../../../../../lib/public-skill-run-stats", () => api);

import { PublicSkillRunStats } from "./public-skill-run-stats";
import { PublicSkillRunStatsPanel } from "./public-skill-run-stats-view";
import { type IntlOptions, messages, withIntl } from "@/test/react";

type IntlMessages = IntlOptions["messages"];
const catalogs: Record<string, IntlMessages> = {
  en: messages,
  "zh-CN": zhCNMessages as IntlMessages,
};
const renderWithIntl = (node: ReactNode, locale = "en") =>
  renderToStaticMarkup(withIntl(node, { locale, messages: catalogs[locale] }));

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

// The sentence is the dashboard's (`skillRunStatsSentence`, tested there);
// here it only has to come out in the page's language.
describe("PublicSkillRunStatsPanel", () => {
  test("en", () => {
    expect(
      renderWithIntl(<PublicSkillRunStatsPanel stats={stats} />),
    ).toContain(
      "Ran 1,240 times in SourceWeft sandboxes in the last 30 days · 92% succeeded · Common issue: missing pptxgenjs",
    );
  });

  test("one run, no issue", () => {
    expect(
      renderWithIntl(
        <PublicSkillRunStatsPanel
          stats={{ ...stats, runs: 1, successRate: 1, topErrors: [] }}
        />,
      ),
    ).toContain(
      "Ran 1 time in SourceWeft sandboxes in the last 30 days · 100% succeeded</p>",
    );
  });

  test("zh-CN, in the aside's own style", () => {
    const html = renderWithIntl(
      <PublicSkillRunStatsPanel stats={stats} />,
      "zh-CN",
    );
    expect(html).toContain(zhCNMessages.dashboardSkillRunStats.heading);
    expect(html).toContain(
      "过去 30 天在 SourceWeft 沙箱中运行了 1,240 次 · 成功率 92% · 常见问题：缺少 pptxgenjs",
    );
    expect(html).toContain("rounded-xl");
  });
});

describe("PublicSkillRunStats", () => {
  test("renders the panel when the stats are available", async () => {
    api.getPublicSkillRunStats.mockResolvedValue(stats);
    const html = renderWithIntl(
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
});
