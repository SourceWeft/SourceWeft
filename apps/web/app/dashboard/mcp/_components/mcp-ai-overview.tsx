"use client";

import * as React from "react";
import { useLocale } from "next-intl";

import {
  getMcpAiOverview,
  mcpOverviewLocale,
  type MarketMcpAiOverview,
} from "../../../../lib/mcp-ai-overview";
import { McpAiOverviewView } from "../../../_components/market/mcp-ai-overview-view";

/**
 * The AI overview at the top of an MCP server's Overview tab, in the viewer's
 * language (English when there is none in it). Read from the public market,
 * like a skill's: a server that is not public, has no overview yet, or whose
 * read fails shows nothing at all, and the author's description below stays
 * as it is.
 */
export function McpAiOverview({ identifier }: { identifier: string }) {
  const locale = mcpOverviewLocale(useLocale());
  const [overview, setOverview] = React.useState<MarketMcpAiOverview | null>(
    null,
  );

  React.useEffect(() => {
    let cancelled = false;
    setOverview(null);
    getMcpAiOverview(identifier, locale)
      .then((found) => {
        if (!cancelled) setOverview(found);
      })
      .catch(() => {
        // An optional extra: a failure is the same as having none.
      });
    return () => {
      cancelled = true;
    };
  }, [identifier, locale]);

  if (!overview) return null;
  return <McpAiOverviewView overview={overview} requestedLocale={locale} />;
}
