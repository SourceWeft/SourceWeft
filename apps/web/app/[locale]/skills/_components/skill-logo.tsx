"use client";

import type { MarketSkillSummary } from "@sourceweft/market-sdk";

import { cn } from "@sourceweft/ui-web/lib/utils";

import { useLogoImage } from "@/lib/use-logo-image";
import { SkillIcon } from "../../../_components/site-icons";
import { safeSkillLogoUrl } from "./skills-format";

/**
 * A skill's logo, or the generic tile when it has none or it fails to load. The
 * image is either a PNG thumbnail made at ingest (a data: URL) or the
 * publisher's GitHub avatar; anything else is not rendered.
 *
 * The generic tile stays underneath until the logo has loaded, so the tile is
 * never empty while a slow avatar loads or before hydration.
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
  const image = useLogoImage(url);
  const loaded = image.status === "loaded";

  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl",
        size === "lg" ? "size-16" : "size-11",
        loaded
          ? cn(
              "ring-1 ring-zinc-200 dark:ring-white/10",
              image.backdrop === "dark" ? "bg-zinc-900" : "bg-white",
            )
          : verified
            ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
            : "bg-zinc-200 text-zinc-700 dark:bg-white/10 dark:text-zinc-200",
      )}
    >
      {loaded ? null : (
        <SkillIcon className={size === "lg" ? "size-7" : "size-5"} />
      )}
      {url && image.status !== "failed" ? (
        // A plain <img>: the source is a data: URL or a third-party avatar, which
        // the Next image optimizer is not configured for and need not be.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={url}
          alt=""
          className="absolute inset-0 size-full object-cover"
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={url}
          {...image.imageProps}
        />
      ) : null}
    </span>
  );
}
