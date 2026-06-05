import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type GlobalIconName = string;
export type GlobalIconTone = "brand" | "mono";

export const DEFAULT_GLOBAL_TOOL_ICON_NAME = "tool";
export const DEFAULT_GLOBAL_SKILL_ICON_NAME = "skill";

const GLOBAL_ICON_NAME_PATTERN = /^[a-z0-9-]+$/;

export function isGlobalIconTone(
  value: string | undefined,
): value is GlobalIconTone {
  return value === "brand" || value === "mono";
}

export function sanitizeGlobalIconName(
  value: string | undefined,
  fallback = DEFAULT_GLOBAL_TOOL_ICON_NAME,
) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return GLOBAL_ICON_NAME_PATTERN.test(normalized) ? normalized : fallback;
}

export function getGlobalIconSrc(
  iconName: string | undefined,
  fallbackIconName = DEFAULT_GLOBAL_TOOL_ICON_NAME,
) {
  return `/icons/${sanitizeGlobalIconName(iconName, fallbackIconName)}.svg`;
}

function applyGlobalIconMaskStyles(element: HTMLElement, src: string) {
  element.style.maskImage = `url("${src}")`;
  element.style.maskPosition = "center";
  element.style.maskRepeat = "no-repeat";
  element.style.maskSize = "contain";
  element.style.webkitMaskImage = `url("${src}")`;
  element.style.webkitMaskPosition = "center";
  element.style.webkitMaskRepeat = "no-repeat";
  element.style.webkitMaskSize = "contain";
}

export type GlobalIconProps = {
  className: string;
  fallbackIconName?: string;
  icon?: ReactNode;
  iconName?: GlobalIconName;
  iconSrc?: string;
  iconTone?: GlobalIconTone;
};

export function createGlobalIconElement({
  className,
  fallbackIconName,
  iconName,
  iconSrc,
  iconTone = "mono",
}: Omit<GlobalIconProps, "icon">) {
  const src = iconSrc ?? getGlobalIconSrc(iconName, fallbackIconName);

  if (iconTone === "brand" || iconSrc) {
    const image = document.createElement("img");
    image.alt = "";
    image.className = `${className} object-contain`;
    image.decoding = "async";
    image.draggable = false;
    image.loading = "lazy";
    image.src = src;
    return image;
  }

  const iconElement = document.createElement("span");
  iconElement.className = cn("inline-flex bg-current", className);
  applyGlobalIconMaskStyles(iconElement, src);
  return iconElement;
}

export function GlobalIcon({
  className,
  fallbackIconName,
  icon,
  iconName,
  iconSrc,
  iconTone = "mono",
}: GlobalIconProps) {
  if (icon) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex items-center justify-center overflow-hidden [&_img]:size-full [&_svg]:size-full",
          className,
        )}
      >
        {icon}
      </span>
    );
  }

  const src = iconSrc ?? getGlobalIconSrc(iconName, fallbackIconName);
  if (iconTone === "brand" || iconSrc) {
    return (
      <img
        alt=""
        aria-hidden="true"
        className={cn("object-contain", className)}
        decoding="async"
        draggable={false}
        loading="lazy"
        src={src}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex bg-current", className)}
      style={{
        WebkitMask: `url("${src}") center / contain no-repeat`,
        mask: `url("${src}") center / contain no-repeat`,
      }}
    />
  );
}
