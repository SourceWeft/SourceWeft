"use client";

import { useLocale as useDisplayLocale } from "next-intl";
import Link from "next/link";
import type { SkillClaimsOverview } from "@sourceweft/contracts";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";

import { useTranslations } from "next-intl";
import { RestoreToMarketButton } from "../../_components/community/restore-to-market-button";
import { claimPageSearch, formatClaimDate, sortClaims } from "./claim-view";

/** The user's claims, then repositories their linked account could claim. */
export function ClaimLists({
  overview,
  workspaceId,
  onChanged,
}: {
  overview: SkillClaimsOverview;
  // For putting a removed repository back; without them no restore is offered.
  workspaceId?: string | null;
  onChanged?: () => void;
}) {
  const displayLocale = useDisplayLocale();
  const t = useTranslations("dashboardSkillsClaim");
  const claims = sortClaims(overview.claims);
  return (
    <div className="space-y-4">
      {overview.suggestions.length > 0 ? (
        <section
          aria-label={t("page.suggestionsTitle")}
          className="rounded-2xl border border-border bg-background p-5 shadow-xs"
        >
          <h2 className="text-sm font-semibold text-foreground">
            {t("page.suggestionsTitle")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("page.suggestionsBody")}
          </p>
          <ul className="mt-3 divide-y divide-border text-xs">
            {overview.suggestions.map((suggestion) => (
              <li
                className="flex items-center justify-between gap-3 py-2"
                key={suggestion.repo}
              >
                <span className="min-w-0 truncate font-medium text-foreground">
                  {suggestion.repo}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {t("page.skillCount", { count: suggestion.skillCount })}
                  </span>
                </span>
                <Link
                  className="font-medium text-primary underline-offset-2 hover:underline"
                  href={`/dashboard/skills/claim${claimPageSearch(suggestion.repo)}`}
                >
                  {t("page.suggestionAction")}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        aria-label={t("page.yourClaims")}
        className="rounded-2xl border border-border bg-background p-5 shadow-xs"
      >
        <h2 className="text-sm font-semibold text-foreground">
          {t("page.yourClaims")}
        </h2>
        {claims.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("page.noClaims")}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border text-xs">
            {claims.map((claim) => (
              <li
                className="flex flex-wrap items-center justify-between gap-2 py-2"
                key={claim.id}
              >
                <Link
                  className="min-w-0 truncate font-medium text-foreground underline-offset-2 hover:underline"
                  href={`/dashboard/skills/claim${claimPageSearch(claim.repo)}`}
                >
                  {claim.repo}
                </Link>
                <span className="flex items-center gap-2 text-muted-foreground">
                  <span>
                    {t.has(`page.methodLabel.${claim.method}`)
                      ? t(`page.methodLabel.${claim.method}`)
                      : claim.method}
                  </span>
                  <span>
                    {formatClaimDate(
                      claim.verifiedAt ?? claim.createdAt,
                      displayLocale,
                    )}
                  </span>
                  <Badge
                    className="h-5 px-1.5 text-[10px]"
                    variant={
                      claim.status === "verified" ? "secondary" : "outline"
                    }
                  >
                    {t.has(`page.status.${claim.status}`)
                      ? t(`page.status.${claim.status}`)
                      : claim.status}
                  </Badge>
                  {workspaceId &&
                  claim.status === "verified" &&
                  claim.removedAt ? (
                    <RestoreToMarketButton
                      claimId={claim.id}
                      onRestored={() => onChanged?.()}
                      workspaceId={workspaceId}
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
