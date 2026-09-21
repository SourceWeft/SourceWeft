"use client";

import * as React from "react";
import Link from "next/link";
import { BadgeCheck, Check, Copy, Loader2 } from "lucide-react";
import type {
  SkillClaimMethod,
  SkillClaimRepository,
} from "@sourceweft/contracts";
import { Button } from "@sourceweft/ui-web/components/ui/button";

import { GitHubIcon } from "../../../../_components/brand-icons";
import { skillsClaimCopy } from "../../_components/skills-claim-copy";
import { formatClaimDate, type ClaimRepositoryPlan } from "./claim-view";

const copy = skillsClaimCopy.page;

/** Where a user links their GitHub account (better-auth-ui's security view). */
const SECURITY_SETTINGS_HREF = "/settings/security";

function CopyableToken({ token }: { token: string }) {
  const [copied, setCopied] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  async function copyToken() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setFailed(false);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  }
  return (
    <div>
      <div className="flex items-stretch gap-2">
        <code
          className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-[11px] text-foreground select-all"
          data-testid="skill-claim-token"
        >
          {token}
        </code>
        <Button
          aria-label={copy.copy}
          onClick={() => void copyToken()}
          size="sm"
          type="button"
          variant="outline"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? copy.copied : copy.copy}
        </Button>
      </div>
      {failed ? (
        <p className="mt-1 text-destructive">{copy.copyFailed}</p>
      ) : null}
    </div>
  );
}

/**
 * One repository on the claim page: whose it is, and — when nobody has
 * claimed it — the two ways to prove it is yours.
 */
export function ClaimRepositoryCard({
  busy,
  error,
  onStart,
  onVerify,
  plan,
  repository,
}: {
  busy: boolean;
  error: string | null;
  onStart: (method: SkillClaimMethod) => void;
  onVerify: (claimId: string) => void;
  plan: ClaimRepositoryPlan;
  repository: SkillClaimRepository;
}) {
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
          {copy.skillCount(repository.skillCount)}
        </span>
      </div>

      {plan.kind === "claimedByYou" ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-foreground">
          <BadgeCheck className="size-4 text-primary" />
          {copy.claimedByYou}
        </p>
      ) : plan.kind === "claimedBySomeone" ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {copy.claimedBySomeone}
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {copy.methodsTitle}
          </h3>

          <div className="rounded-lg border border-border p-4 text-xs">
            <h4 className="text-sm font-medium text-foreground">
              {copy.accountTitle}
            </h4>
            <p className="mt-1 text-muted-foreground">{copy.accountBody}</p>
            {plan.account.reason ? (
              <p className="mt-2 text-amber-700 dark:text-amber-300">
                {copy.accountHints[plan.account.reason]}{" "}
                {plan.account.reason === "not_linked" ? (
                  <Link
                    className="font-medium underline underline-offset-2"
                    href={SECURITY_SETTINGS_HREF}
                  >
                    {copy.linkGitHub}
                  </Link>
                ) : null}
              </p>
            ) : null}
            <Button
              className="mt-3"
              disabled={busy || !plan.account.available}
              onClick={() => onStart("github_account")}
              size="sm"
              type="button"
            >
              <GitHubIcon className="size-3.5" />
              {copy.accountAction}
            </Button>
          </div>

          <div className="rounded-lg border border-border p-4 text-xs">
            <h4 className="text-sm font-medium text-foreground">
              {copy.fileTitle}
            </h4>
            <p className="mt-1 text-muted-foreground">{copy.fileBody}</p>

            {plan.file.state === "token" ? (
              <div className="mt-3 space-y-2">
                <p className="text-foreground">
                  {copy.fileSteps.create}{" "}
                  <code className="rounded bg-muted/60 px-1 font-mono">
                    {plan.file.path}
                  </code>{" "}
                  {plan.file.branch
                    ? copy.fileSteps.branch(plan.file.branch)
                    : copy.fileSteps.branchUnknown}{" "}
                  {copy.fileSteps.contents}
                </p>
                <CopyableToken token={plan.file.token} />
                <p className="text-muted-foreground">{copy.tokenOnce}</p>
                <p className="text-muted-foreground">{copy.fileSteps.then}</p>
              </div>
            ) : plan.file.state === "pending" ? (
              <p className="mt-3 text-muted-foreground">
                {copy.tokenPending(formatClaimDate(plan.file.expiresAt))}
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              {plan.file.state === "none" ? (
                <Button
                  disabled={busy}
                  onClick={() => onStart("verification_file")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {copy.fileAction}
                </Button>
              ) : (
                <>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      if (plan.file.state !== "none") onVerify(plan.file.claimId);
                    }}
                    size="sm"
                    type="button"
                  >
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {copy.verify}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => onStart("verification_file")}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {copy.fileNewToken}
                  </Button>
                </>
              )}
            </div>
          </div>
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
