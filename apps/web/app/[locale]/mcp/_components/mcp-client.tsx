"use client";

import { useState } from "react";
import { Check, Copy, CopyX } from "lucide-react";

import type { MarketMcpIconSource } from "@sourceweft/market-sdk";

import { useLogoImage } from "@/lib/use-logo-image";
import { McpIcon as McpBrandIcon } from "../../../_components/site-icons";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { mcpIconMonogram, safeMcpIconUrl } from "./mcp-icon-url";

const iconSizeClassName = {
  sm: "size-9",
  md: "size-11",
  lg: "size-16",
} as const;

const monogramClassName = {
  sm: "text-base",
  md: "text-lg",
  lg: "text-2xl",
} as const;

/**
 * A server's logo, or its placeholder: the first letter of `name` (a
 * monogram), else the generic MCP glyph. The placeholder stays underneath
 * until the image has loaded and takes over when there is no icon, when the
 * URL is not one this page renders (see `safeMcpIconUrl`) or when the image
 * fails to load, so a broken image is never shown, before hydration included.
 */
export function McpIcon({
  iconSource,
  iconUrl,
  name,
  size = "md",
  trusted,
}: {
  iconSource?: MarketMcpIconSource | null;
  iconUrl?: string | null;
  name?: string | null;
  size?: keyof typeof iconSizeClassName;
  trusted: boolean;
}) {
  const src = safeMcpIconUrl(iconUrl, iconSource);
  const image = useLogoImage(src);
  const loaded = image.status === "loaded";
  const monogram = mcpIconMonogram(name);
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl",
        iconSizeClassName[size],
        loaded
          ? "border border-zinc-200 bg-white dark:border-white/10"
          : trusted
            ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
            : "bg-amber-600 text-white",
      )}
    >
      {loaded ? null : monogram ? (
        <span
          aria-hidden="true"
          className={cn("font-semibold leading-none", monogramClassName[size])}
          data-mcp-icon-monogram=""
        >
          {monogram}
        </span>
      ) : (
        <McpBrandIcon className={size === "lg" ? "size-7" : "size-5"} />
      )}
      {src && image.status !== "failed" ? (
        // Registry icons come from arbitrary https hosts, so Next Image's
        // static remote-host allowlist does not apply.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          alt=""
          className="absolute inset-1.5 size-auto max-h-full object-contain"
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={src}
          {...image.imageProps}
        />
      ) : null}
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
