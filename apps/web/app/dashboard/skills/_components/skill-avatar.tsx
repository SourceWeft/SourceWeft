"use client";

import { useState } from "react";
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
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const url = item.logo?.url;
  const failed = Boolean(url && url === failedUrl);
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
        "relative inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/40 text-primary",
        className,
      )}
    >
      {url && !failed ? (
        <>
          {loadedUrl !== url ? (
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
              loadedUrl !== url && "opacity-0",
            )}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailedUrl(url)}
            onLoad={() => setLoadedUrl(url)}
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
