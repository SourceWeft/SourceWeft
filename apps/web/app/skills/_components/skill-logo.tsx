"use client";

import { useState } from "react";
import type { MarketSkillSummary } from "@sourceweft/market-sdk";

import { cn } from "@sourceweft/ui-web/lib/utils";

import { SkillIcon } from "../../_components/site-icons";
import { safeSkillLogoUrl } from "./skills-format";

/**
 * A skill's logo, or the generic tile when it has none or it fails to load. The
 * image is either a PNG thumbnail made at ingest (a data: URL) or the
 * publisher's GitHub avatar; anything else is not rendered.
 */
export function SkillTile({
  logo,
  size = "md",
  verified,
}: {
  logo?: MarketSkillSummary["logo"];
  size?: "md" | "lg";
  verified: boolean;
}) {
  const url = safeSkillLogoUrl(logo?.url);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const box = size === "lg" ? "size-16" : "size-11";

  if (url && failedUrl !== url) {
    return (
      // A plain <img>: the source is a data: URL or a third-party avatar, which
      // the Next image optimizer is not configured for and need not be.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        alt=""
        className={cn(
          "shrink-0 rounded-xl bg-white object-cover ring-1 ring-zinc-200 dark:ring-white/10",
          box,
        )}
        decoding="async"
        loading="lazy"
        onError={() => setFailedUrl(url)}
        referrerPolicy="no-referrer"
        src={url}
      />
    );
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl",
        box,
        verified
          ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
          : "bg-zinc-200 text-zinc-700 dark:bg-white/10 dark:text-zinc-200",
      )}
    >
      <SkillIcon className={size === "lg" ? "size-7" : "size-5"} />
    </span>
  );
}
