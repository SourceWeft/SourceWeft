import { useTranslations } from "next-intl";
import type { MarketMcpToolsReference } from "@sourceweft/market-contracts";
import { formatDate } from "./mcp-display";

/**
 * Where the tool list on a public MCP page came from when it is neither the
 * owner's nor the registry's (Issue #367): read by SourceWeft with a reference
 * account, or observed through members' own connections. Says so beside the
 * list, with the date, and flags a list that was read from an address the
 * listing no longer has. The profile of the reference account stays out of the
 * page: "a standard test account" is all it says. Holds no member data.
 */
export function McpToolsReference({
  reference,
}: {
  reference: MarketMcpToolsReference;
}) {
  const t = useTranslations("mcp.toolsReference");
  const date = formatDate(reference.observedAt);
  return (
    <div
      className="mb-3 space-y-1 text-sm text-zinc-600 dark:text-zinc-400"
      data-source={reference.source}
      data-stale={reference.stale ? "true" : "false"}
      data-testid="mcp-tools-reference"
    >
      <p>
        {reference.source === "platform-indexed"
          ? t("platformIndexed", { date })
          : t("memberObserved", { date })}
      </p>
      {reference.stale ? (
        <p className="font-medium text-amber-700 dark:text-amber-400">
          {t("stale")}
        </p>
      ) : null}
    </div>
  );
}
