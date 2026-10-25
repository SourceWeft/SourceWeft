"use client";

import { useLocale, useTranslations } from "next-intl";
import type { McpClaim } from "@sourceweft/contracts";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";

import { formatMcpClaimDate, sortMcpClaims } from "./mcp-claim-view";

function isExpired(claim: McpClaim) {
  return Boolean(
    claim.expiresAt && new Date(claim.expiresAt).getTime() < Date.now(),
  );
}

/**
 * The viewer's claims on this server: pending ones with their expiry, last
 * failure and a Verify button (their token cannot be shown again), plus any
 * verified or revoked ones.
 */
export function McpClaimList({
  busy,
  claims,
  onVerify,
}: {
  busy: boolean;
  claims: readonly McpClaim[];
  onVerify: (claimId: string) => void;
}) {
  const t = useTranslations("dashboardMcpClaim.page.claims");
  const locale = useLocale();
  const sorted = sortMcpClaims(claims);
  const hasPending = sorted.some((claim) => claim.status === "pending");

  return (
    <section
      aria-label={t("title")}
      className="rounded-2xl border border-border bg-background p-5 shadow-xs"
      data-testid="mcp-claim-list"
    >
      <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
      {sorted.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("none")}</p>
      ) : (
        <>
          {hasPending ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("tokenHidden")}
            </p>
          ) : null}
          <ul className="mt-3 divide-y divide-border text-xs">
            {sorted.map((claim) => {
              const expired = claim.status === "pending" && isExpired(claim);
              return (
                <li className="space-y-1 py-2" key={claim.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="font-medium text-foreground">
                        {t(`method.${claim.method}`)}
                      </span>
                      <span className="truncate font-mono text-muted-foreground">
                        {claim.target}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Badge
                        className="h-5 px-1.5 text-[10px]"
                        variant={
                          claim.status === "verified" ? "secondary" : "outline"
                        }
                      >
                        {t(`status.${claim.status}`)}
                      </Badge>
                      {claim.status === "pending" && !expired ? (
                        <Button
                          disabled={busy}
                          onClick={() => onVerify(claim.id)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {t("verify")}
                        </Button>
                      ) : null}
                    </span>
                  </div>
                  {claim.status === "pending" && claim.expiresAt ? (
                    <p className="text-muted-foreground">
                      {t(expired ? "expired" : "expires", {
                        date: formatMcpClaimDate(claim.expiresAt, locale),
                      })}
                    </p>
                  ) : null}
                  {claim.status === "pending" && claim.lastError ? (
                    <p className="text-destructive">
                      {t("lastError", { error: claim.lastError })}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
