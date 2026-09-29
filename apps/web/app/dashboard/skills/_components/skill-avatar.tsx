"use client";

import {
  BookOpen,
  Code2,
  FileText,
  ImageIcon,
  Presentation,
  Video,
} from "lucide-react";
import type { SkillLogo } from "@sourceweft/contracts";
import { useTranslations } from "next-intl";
import { GlobalIcon } from "@sourceweft/ui-web/components/ui/global-icon";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { useLogoImage } from "@/lib/use-logo-image";

const builtinIcons = {
  feynman: BookOpen,
  html: Code2,
  "html-slides": Presentation,
  "image-generate": ImageIcon,
  "ppt-deck": Presentation,
  "meeting-summary": FileText,
  "video-presentation": Video,
};

export function SkillAvatar({
  item,
  className,
  icon,
}: {
  item: {
    displayName: string;
    slug: string;
    sourceType: string;
    logo?: SkillLogo;
  };
  className?: string;
  icon?: { iconName?: string; iconTone?: "brand" | "mono" };
}) {
  const t = useTranslations("dashboardSkills");
  const url = item.logo?.url;
  const image = useLogoImage(url);
  const failed = image.status === "failed";
  const loaded = image.status === "loaded";
  const BuiltinIcon =
    item.sourceType === "builtin"
      ? builtinIcons[item.slug as keyof typeof builtinIcons]
      : undefined;
  const initials = item.displayName
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join("")
    .toUpperCase();
  const label = failed
    ? t("avatar.logoUnavailable", { name: item.displayName })
    : item.logo?.source === "publisher"
      ? t("avatar.publisherAvatar", { name: item.displayName })
      : t("avatar.logo", { name: item.displayName });
  return (
    <span
      title={label}
      className={cn(
        "relative inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 text-primary",
        // A loaded logo sits on the backdrop its own colors need, whatever the
        // theme; the themed muted tile would hide dark artwork in dark mode.
        // Clipped to the padding box so it does not tint the translucent border.
        loaded
          ? cn(
              "bg-clip-padding",
              image.backdrop === "dark" ? "bg-zinc-900" : "bg-white",
            )
          : "bg-muted/40",
        className,
      )}
    >
      {url && !failed ? (
        <>
          {!loaded ? (
            <span aria-hidden="true" className="text-[0.65em] font-semibold">
              {initials || "S"}
            </span>
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element -- Thumbnails are already sized; external logos load in the browser without a server proxy. */}
          <img
            key={url}
            src={url}
            alt={label}
            className={cn(
              "absolute inset-0 size-full object-contain",
              !loaded && "opacity-0",
            )}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            {...image.imageProps}
          />
        </>
      ) : icon?.iconName && item.sourceType === "builtin" ? (
        <GlobalIcon
          className="size-1/2"
          iconName={icon.iconName}
          iconTone={icon.iconTone}
          fallbackIconName="skill"
        />
      ) : BuiltinIcon ? (
        <BuiltinIcon aria-hidden="true" className="size-1/2" />
      ) : (
        <span
          aria-label={label}
          className="text-[0.65em] font-semibold leading-none"
        >
          {initials || "S"}
        </span>
      )}
    </span>
  );
}
