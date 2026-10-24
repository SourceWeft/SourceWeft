"use client";

import { Loader2, TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { McpClaim, McpClaimInstructions } from "@sourceweft/contracts";
import { Button } from "@sourceweft/ui-web/components/ui/button";

import { CopyField } from "./copy-field";
import { formatMcpClaimDate } from "./mcp-claim-view";

/**
 * What a pending domain claim's owner has to publish, shown once right after
 * the claim starts: the token is not retrievable later, so the page keeps it
 * in state and tells the user to copy it now.
 */
export function McpClaimInstructionsCard({
  busy,
  claim,
  instructions,
  onVerify,
}: {
  busy: boolean;
  claim: McpClaim;
  instructions: McpClaimInstructions;
  onVerify: (claimId: string) => void;
}) {
  const t = useTranslations("dashboardMcpClaim.page.instructions");
  const locale = useLocale();
  const dns = claim.method === "dns_txt";

  return (
    <section
      aria-label={t("title")}
      className="rounded-2xl border border-border bg-background p-5 shadow-xs"
      data-testid="mcp-claim-instructions"
    >
      <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
      <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        {t("onceNote")}
      </p>

      <div className="mt-4 space-y-3">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {dns ? t("dnsTitle") : t("wellKnownTitle")}
        </h3>
        {dns ? (
          <>
            <CopyField
              label={t("recordName")}
              value={instructions.dnsRecordName}
            />
            <CopyField
              label={t("recordValue")}
              value={instructions.dnsRecordValue}
            />
            <p className="text-xs text-muted-foreground">{t("dnsHint")}</p>
          </>
        ) : (
          <>
            <CopyField label={t("url")} value={instructions.wellKnownUrl} />
            <CopyField
              label={t("body")}
              multiline
              value={instructions.wellKnownBody}
            />
          </>
        )}
        <p className="text-xs text-muted-foreground">
          {t("expires", {
            date: formatMcpClaimDate(instructions.expiresAt, locale),
          })}
        </p>
      </div>

      <Button
        className="mt-4"
        disabled={busy}
        onClick={() => onVerify(claim.id)}
        size="sm"
        type="button"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {t("verify")}
      </Button>
    </section>
  );
}
