"use client";

import Link from "next/link";
import { BadgeCheck, Building2, Mail } from "lucide-react";
import { useTranslations } from "next-intl";
import type { SkillClaimRepository } from "@sourceweft/contracts";
import { Button } from "@sourceweft/ui-web/components/ui/button";

import { GitHubIcon } from "../../../../_components/brand-icons";
import { claimRequestMailto, type ClaimRepositoryPlan } from "./claim-view";

/** Where a user links their GitHub account (better-auth-ui's security view). */
const SECURITY_SETTINGS_HREF = "/settings/security";

/**
 * One repository on the claim page: whose it is, and — when nobody has
 * claimed it — how its owner claims it: with their linked GitHub account for
 * a personal repository, or by asking an admin for an organization's.
 */
export function ClaimRepositoryCard({
  busy,
  error,
  onClaim,
  plan,
  repository,
}: {
  busy: boolean;
  error: string | null;
  onClaim: () => void;
  plan: ClaimRepositoryPlan;
  repository: SkillClaimRepository;
}) {
  const t = useTranslations("dashboardSkillsClaim");
  return (
    <section
      aria-label={repository.repo}
      className="rounded-2xl border border-border bg-background p-5 shadow-xs"
      data-testid="skill-claim-repository"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <GitHubIcon className="size-4" />
          {repository.repo}
        </h2>
        <span className="text-xs text-muted-foreground">
          {t("page.skillCount", { count: repository.skillCount })}
        </span>
      </div>

      {plan.kind === "claimedByYou" ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-foreground">
          <BadgeCheck className="size-4 text-primary" />
          {t("page.claimedByYou")}
        </p>
      ) : plan.kind === "claimedBySomeone" ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {t("page.claimedBySomeone")}
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("page.methodsTitle")}
          </h3>

          {plan.kind === "organization" ? (
            <div
              className="rounded-lg border border-border p-4 text-xs"
              data-testid="skill-claim-organization"
            >
              <h4 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Building2 className="size-4" />
                {t("page.organizationTitle")}
              </h4>
              <p className="mt-1 text-muted-foreground">
                {t("page.organizationBody")}
              </p>
              <Button asChild className="mt-3" size="sm" variant="outline">
                <a href={claimRequestMailto(repository.repo)}>
                  <Mail className="size-3.5" />
                  {t("page.organizationAction")}
                </a>
              </Button>
            </div>
          ) : (
            <div className="rounded-lg border border-border p-4 text-xs">
              <h4 className="text-sm font-medium text-foreground">
                {t("page.accountTitle")}
              </h4>
              <p className="mt-1 text-muted-foreground">
                {t("page.accountBody")}
              </p>
              {plan.account.reason ? (
                <p className="mt-2 text-amber-700 dark:text-amber-300">
                  {t.has(`page.accountHints.${plan.account.reason}`)
                    ? t(`page.accountHints.${plan.account.reason}`)
                    : null}{" "}
                  {plan.account.reason === "not_linked" ? (
                    <Link
                      className="font-medium underline underline-offset-2"
                      href={SECURITY_SETTINGS_HREF}
                    >
                      {t("page.linkGitHub")}
                    </Link>
                  ) : null}
                </p>
              ) : null}
              <Button
                className="mt-3"
                disabled={busy || !plan.account.available}
                onClick={onClaim}
                size="sm"
                type="button"
              >
                <GitHubIcon className="size-3.5" />
                {t("page.accountAction")}
              </Button>
            </div>
          )}
        </div>
      )}

      {error ? (
        <p className="mt-3 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
