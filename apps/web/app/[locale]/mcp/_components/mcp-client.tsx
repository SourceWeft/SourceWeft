"use client";

import { useState } from "react";
import { Check, Copy, CopyX } from "lucide-react";

import { McpIcon as McpBrandIcon } from "../../../_components/site-icons";
import { cn } from "@sourceweft/ui-web/lib/utils";

const iconSizeClassName = {
  sm: "size-9",
  md: "size-11",
  lg: "size-16",
} as const;

export function McpIcon({
  iconUrl,
  size = "md",
  trusted,
}: {
  iconUrl?: string | null;
  size?: keyof typeof iconSizeClassName;
  trusted: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(iconUrl) && !failed;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-xl",
        iconSizeClassName[size],
        showImage
          ? "border border-zinc-200 bg-white p-1.5 dark:border-white/10"
          : trusted
            ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
            : "bg-amber-600 text-white",
      )}
    >
      {showImage ? (
        // Registry icons come from arbitrary https hosts, so Next Image's
        // static remote-host allowlist does not apply.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          className="size-full object-contain"
          loading="lazy"
          onError={() => setFailed(true)}
          referrerPolicy="no-referrer"
          src={iconUrl!}
        />
      ) : (
        <McpBrandIcon className={size === "lg" ? "size-7" : "size-5"} />
      )}
    </span>
  );
}

/**
 * Copies `value`, then says `copiedLabel` for a moment, or `failedLabel` when
 * nothing was copied: a refused clipboard, or none at all on a plain-http
 * page. The labels arrive translated. `onCopied` runs only once the clipboard
 * took the text.
 */
export function CopyButton({
  className,
  copiedLabel,
  failedLabel,
  label,
  onCopied,
  value,
}: {
  className?: string;
  copiedLabel: string;
  failedLabel: string;
  label: string;
  onCopied?: () => void;
  value: string;
}) {
  const [outcome, setOutcome] = useState<"copied" | "failed" | null>(null);

  function show(next: "copied" | "failed") {
    setOutcome(next);
    window.setTimeout(() => setOutcome(null), 1600);
  }

  return (
    <button
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 text-xs font-medium text-zinc-700 transition-colors hover:border-zinc-950 hover:text-zinc-950 dark:border-white/12 dark:bg-white/[0.04] dark:text-zinc-300 dark:hover:border-white/40 dark:hover:text-white",
        className,
      )}
      onClick={() => {
        // Undefined outside a secure context, whatever the DOM types say.
        const clipboard: Clipboard | undefined = navigator.clipboard;
        if (!clipboard) {
          show("failed");
          return;
        }
        clipboard.writeText(value).then(
          () => {
            show("copied");
            onCopied?.();
          },
          () => show("failed"),
        );
      }}
      type="button"
    >
      {outcome === "copied" ? (
        <Check className="size-3.5" />
      ) : outcome === "failed" ? (
        <CopyX className="size-3.5" />
      ) : (
        <Copy className="size-3.5" />
      )}
      {outcome === "copied"
        ? copiedLabel
        : outcome === "failed"
          ? failedLabel
          : label}
    </button>
  );
}
