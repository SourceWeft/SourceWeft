"use client";

import * as React from "react";
import { LibraryBig, ShieldAlert } from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@sourceweft/ui-web/components/ui/tabs";
import { McpIcon, SkillIcon } from "../../../_components/site-icons";
import { skillsMarketCopy } from "../../skills/_components/skills-market-copy";
import { McpReviewQueue } from "./_components/mcp-review-queue";
import { SkillCollectionsAdmin } from "./_components/skill-collections-admin";
import { SkillReviewQueue } from "./_components/skill-review-queue";

const copy = skillsMarketCopy.review;

type ReviewTab = "mcp" | "skills" | "collections";

function asTab(value: string | null): ReviewTab {
  return value === "skills" || value === "collections" ? value : "mcp";
}

function tabFromLocation(): ReviewTab {
  if (typeof window === "undefined") return "mcp";
  return asTab(new URLSearchParams(window.location.search).get("tab"));
}

export default function MarketReviewPage() {
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
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <ShieldAlert className="size-4" />
        {copy.pageEyebrow}
      </div>
      <Tabs className="mt-4 gap-6" onValueChange={changeTab} value={tab}>
        <TabsList>
          <TabsTrigger className="px-3" value="mcp">
            <McpIcon />
            {copy.tabMcp}
          </TabsTrigger>
          <TabsTrigger className="px-3" value="skills">
            <SkillIcon />
            {copy.tabSkills}
          </TabsTrigger>
          <TabsTrigger className="px-3" value="collections">
            <LibraryBig />
            {skillsMarketCopy.collections.tab}
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
      </Tabs>
    </div>
  );
}
