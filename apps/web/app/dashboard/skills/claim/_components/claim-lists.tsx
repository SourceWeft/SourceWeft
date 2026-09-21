"use client";

import Link from "next/link";
import type { SkillClaimsOverview } from "@sourceweft/contracts";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";

import { skillsClaimCopy } from "../../_components/skills-claim-copy";
import { claimPageSearch, formatClaimDate, sortClaims } from "./claim-view";

const copy = skillsClaimCopy.page;

/** The user's claims, then repositories their linked account could claim. */
export function ClaimLists({ overview }: { overview: SkillClaimsOverview }) {
  const claims = sortClaims(overview.claims);
  return (
    <div className="space-y-4">
      {overview.suggestions.length > 0 ? (
        <section
          aria-label={copy.suggestionsTitle}
          className="rounded-2xl border border-border bg-background p-5 shadow-xs"
        >
          <h2 className="text-sm font-semibold text-foreground">
            {copy.suggestionsTitle}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {copy.suggestionsBody}
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
                    {copy.skillCount(suggestion.skillCount)}
                  </span>
                </span>
                <Link
                  className="font-medium text-primary underline-offset-2 hover:underline"
                  href={`/dashboard/skills/claim${claimPageSearch(suggestion.repo)}`}
                >
                  {copy.suggestionAction}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        aria-label={copy.yourClaims}
        className="rounded-2xl border border-border bg-background p-5 shadow-xs"
      >
        <h2 className="text-sm font-semibold text-foreground">
          {copy.yourClaims}
        </h2>
        {claims.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">{copy.noClaims}</p>
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
                  <span>{copy.methodLabel[claim.method]}</span>
                  <span>
                    {formatClaimDate(claim.verifiedAt ?? claim.createdAt)}
                  </span>
                  <Badge
                    className="h-5 px-1.5 text-[10px]"
                    variant={claim.status === "verified" ? "secondary" : "outline"}
                  >
                    {copy.status[claim.status]}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
