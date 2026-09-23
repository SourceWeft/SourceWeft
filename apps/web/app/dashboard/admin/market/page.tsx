"use client";

import * as React from "react";
import { Flag, LibraryBig, List, Settings, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@sourceweft/ui-web/components/ui/tabs";
import { McpIcon, SkillIcon } from "../../../_components/site-icons";
import { McpReviewQueue } from "./_components/mcp-review-queue";
import { SkillAllAdmin } from "./_components/skill-all-admin";
import { SkillCollectionsAdmin } from "./_components/skill-collections-admin";
import { SkillMarketSettingsAdmin } from "./_components/skill-market-settings-admin";
import { SkillReportsAdmin } from "./_components/skill-reports-admin";
import { SkillReviewQueue } from "./_components/skill-review-queue";

type ReviewTab =
  "mcp" | "skills" | "all" | "reports" | "collections" | "settings";

const TABS: readonly ReviewTab[] = [
  "mcp",
  "skills",
  "all",
  "reports",
  "collections",
  "settings",
];

function asTab(value: string | null): ReviewTab {
  return TABS.find((tab) => tab === value) ?? "mcp";
}

function tabFromLocation(): ReviewTab {
  if (typeof window === "undefined") return "mcp";
  return asTab(new URLSearchParams(window.location.search).get("tab"));
}

export default function MarketReviewPage() {
  const t = useTranslations("dashboardSkillsMarket");
  const [tab, setTab] = React.useState<ReviewTab>("mcp");

  // `?tab=skills` / `?tab=collections` make those tabs linkable. Read after
  // mount so the first client render matches the server's.
  React.useEffect(() => {
    setTab(tabFromLocation());
  }, []);

  function changeTab(value: string) {
    const next = asTab(value);
    setTab(next);
    const params = new URLSearchParams(window.location.search);
    if (next === "mcp") params.delete("tab");
    else params.set("tab", next);
    const search = params.toString();
    window.history.replaceState(
      null,
      "",
      search
        ? `${window.location.pathname}?${search}`
        : window.location.pathname,
    );
  }

  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <ShieldAlert className="size-4" />
          {t("review.pageEyebrow")}
        </div>
        <Tabs className="mt-4 gap-6" onValueChange={changeTab} value={tab}>
          <TabsList>
            <TabsTrigger className="px-3" value="mcp">
              <McpIcon />
              {t("review.tabMcp")}
            </TabsTrigger>
            <TabsTrigger className="px-3" value="skills">
              <SkillIcon />
              {t("review.tabSkills")}
            </TabsTrigger>
            <TabsTrigger className="px-3" value="collections">
              <LibraryBig />
              {t("collections.tab")}
            </TabsTrigger>
            <TabsTrigger className="px-3" value="all">
              <List />
              {t("review.tabAll")}
            </TabsTrigger>
            <TabsTrigger className="px-3" value="reports">
              <Flag />
              {t("review.tabReports")}
            </TabsTrigger>
            <TabsTrigger className="px-3" value="settings">
              <Settings />
              {t("review.tabSettings")}
            </TabsTrigger>
          </TabsList>
          {/* Each queue loads when its tab is first opened, not before. */}
          <TabsContent value="mcp">
            <McpReviewQueue />
          </TabsContent>
          <TabsContent value="skills">
            <SkillReviewQueue />
            <SkillReviewQueue queue="listing" />
          </TabsContent>
          <TabsContent value="collections">
            <SkillCollectionsAdmin />
          </TabsContent>
          <TabsContent value="all">
            <SkillAllAdmin />
          </TabsContent>
          <TabsContent value="reports">
            <SkillReportsAdmin />
          </TabsContent>
          <TabsContent value="settings">
            <SkillMarketSettingsAdmin />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
