import { formatDisplayDate } from "@/lib/i18n/format";
import type { useTranslations } from "next-intl";
import type { AgentToolTrustRule } from "@sourceweft/sdk";

/**
 * Row formatting for the "Approvals" settings panel.
 *
 * Every field is rendered from what the server sent. Nothing here knows the
 * name of any tool, connector or capability — a trust rule the user cannot
 * recognise is a trust rule they cannot decide to revoke, so the server's own
 * identifiers are shown verbatim rather than translated through a table this
 * app would have to keep in sync.
 */

export type TrustRuleRow = {
  id: string;
  toolName: string;
  connectorLabel: string;
  riskLabel: string;
  expiryLabel: string;
  lastUsedLabel: string;
  sourceConfirmationLabel: string;
  isExpired: boolean;
};

function formatDate(value: string | null | undefined, displayLocale: string) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }
  return formatDisplayDate(parsed, displayLocale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function isExpiredRule(rule: AgentToolTrustRule, now: Date) {
  if (!rule.expiresAt) {
    return false;
  }
  const expiresAt = new Date(rule.expiresAt).getTime();
  // An unparseable expiry is treated as expired, matching the server-side
  // matcher: failing closed is the only safe direction for a bypass rule.
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

export function toTrustRuleRow(
  rule: AgentToolTrustRule,
  displayLocale: string,
  t: ReturnType<typeof useTranslations>,
  now = new Date(),
): TrustRuleRow {
  const expiryDate = formatDate(rule.expiresAt, displayLocale);
  const expired = isExpiredRule(rule, now);
  return {
    id: rule.id,
    toolName: rule.toolName,
    connectorLabel: rule.connectorId ?? t("approvals.noConnector"),
    riskLabel:
      rule.allowedRiskLevels.length > 0
        ? rule.allowedRiskLevels.join(", ")
        : t("approvals.unknownRisk"),
    expiryLabel: expired
      ? expiryDate
        ? t("approvals.expiredOn", { date: expiryDate })
        : t("approvals.expired")
      : (expiryDate ?? t("approvals.noExpiry")),
    lastUsedLabel:
      formatDate(rule.lastUsedAt, displayLocale) ?? t("approvals.neverUsed"),
    sourceConfirmationLabel:
      rule.createdFromConfirmationId ?? t("approvals.unknownPrompt"),
    isExpired: expired,
  };
}

/**
 * Only active rules are listed. A revoked row would read as a grant that is
 * still in force, and the matcher already treats it as if it were deleted.
 */
export function visibleTrustRules(rules: AgentToolTrustRule[]) {
  return rules.filter((rule) => rule.status === "active");
}
