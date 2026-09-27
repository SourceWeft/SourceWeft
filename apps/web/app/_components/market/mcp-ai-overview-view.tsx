"use client";

import { useTranslations } from "next-intl";

import type {
  MarketMcpAiOverview,
  MarketMcpOverviewLocale,
} from "../../../lib/mcp-ai-overview";
import { CatalogAiOverview } from "./catalog-ai-overview";

/**
 * An MCP server's AI overview, in the shared catalog overview block with the
 * MCP wording: labelled as AI-generated, cautions set apart, and a note when
 * it is shown in English because there is none in the language asked for.
 * The overview text is model output from third-party content and is shown as
 * plain text only.
 */
export function McpAiOverviewView({
  overview,
  requestedLocale,
  className,
}: {
  overview: MarketMcpAiOverview;
  // The language asked for; a note shows when the overview fell back.
  requestedLocale?: MarketMcpOverviewLocale;
  className?: string;
}) {
  const t = useTranslations("mcp.aiOverview");
  const fellBack =
    requestedLocale !== undefined && requestedLocale !== overview.locale;

  return (
    <CatalogAiOverview
      className={className}
      data-testid="mcp-ai-overview"
      explainer={{ label: t("explainerLabel"), text: t("explainer") }}
      labels={{
        title: t("title"),
        whatItDoes: t("whatItDoes"),
        whenToUse: t("whenToUse"),
        requirements: t("requirements"),
      }}
      notice={fellBack ? t("englishFallback") : null}
      overview={overview}
    />
  );
}
