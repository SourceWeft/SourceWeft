"use client";

import * as React from "react";
import { Check, Copy, CopyX } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@sourceweft/ui-web/components/ui/button";

/** A copy-to-clipboard button; labels come from the claim page's catalog. */
export function CopyValueButton({
  label,
  value,
}: {
  /** What is copied, for the accessible name. */
  label: string;
  value: string;
}) {
  const t = useTranslations("dashboardMcpClaim.page.instructions");
  const [outcome, setOutcome] = React.useState<"copied" | "failed" | null>(
    null,
  );

  function show(next: "copied" | "failed") {
    setOutcome(next);
    window.setTimeout(() => setOutcome(null), 1600);
  }

  return (
    <Button
      aria-label={`${t("copy")}: ${label}`}
      onClick={() => {
        // Undefined outside a secure context, whatever the DOM types say.
        const clipboard: Clipboard | undefined = navigator.clipboard;
        if (!clipboard) {
          show("failed");
          return;
        }
        clipboard.writeText(value).then(
          () => show("copied"),
          () => show("failed"),
        );
      }}
      size="sm"
      type="button"
      variant="outline"
    >
      {outcome === "copied" ? (
        <Check className="size-3.5" />
      ) : outcome === "failed" ? (
        <CopyX className="size-3.5" />
      ) : (
        <Copy className="size-3.5" />
      )}
      {outcome === "copied"
        ? t("copied")
        : outcome === "failed"
          ? t("copyFailed")
          : t("copy")}
    </Button>
  );
}

/** A labelled, read-only value with its copy button. */
export function CopyField({
  label,
  multiline = false,
  value,
}: {
  label: string;
  multiline?: boolean;
  value: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-start gap-2">
        <code
          className={
            multiline
              ? "min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-foreground"
              : "min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-foreground"
          }
          title={multiline ? undefined : value}
        >
          {value}
        </code>
        <CopyValueButton label={label} value={value} />
      </div>
    </div>
  );
}
