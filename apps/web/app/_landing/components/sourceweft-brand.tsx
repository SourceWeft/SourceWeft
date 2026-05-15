import Image from "next/image";
import Link from "next/link";

type BrandLockupVariant = "size-only" | "minimal-refined";

const SOURCEWEFT_BRAND_LOCKUP_VARIANT: BrandLockupVariant = "size-only";

export function SourceWeftBrandMark({
  className = "h-6 w-6 rounded-md",
  imageClassName = "",
}: {
  className?: string;
  imageClassName?: string;
}) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 overflow-hidden ${className}`}
    >
      <Image
        src="/icon-512.png"
        alt=""
        width={40}
        height={40}
        className={`h-full w-full object-contain ${imageClassName}`}
      />
    </span>
  );
}

export function SourceWeftBrandLockup({
  size = "nav",
}: {
  size?: "nav" | "footer";
}) {
  const refined = SOURCEWEFT_BRAND_LOCKUP_VARIANT === "minimal-refined";

  const gapClassName =
    size === "nav"
      ? refined
        ? "gap-3.5"
        : "gap-2.5"
      : refined
        ? "gap-2.5"
        : "gap-2";

  const markClassName =
    size === "nav"
      ? refined
        ? "h-10 w-10 rounded-xl ring-1 ring-zinc-900/10 shadow-[0_8px_20px_rgba(24,24,27,0.16)] transition-all duration-300 group-hover:-translate-y-0.5 group-hover:shadow-[0_12px_26px_rgba(24,24,27,0.22)] dark:ring-white/12 dark:shadow-[0_10px_22px_rgba(0,0,0,0.45)] dark:group-hover:shadow-[0_14px_30px_rgba(0,0,0,0.52)]"
        : "h-8 w-8 rounded-md transition-transform duration-300 group-hover:scale-[1.03]"
      : refined
        ? "h-9 w-9 rounded-lg ring-1 ring-zinc-900/10 shadow-[0_6px_16px_rgba(24,24,27,0.14)] dark:ring-white/12 dark:shadow-[0_8px_20px_rgba(0,0,0,0.45)]"
        : "h-7 w-7 rounded-md";

  const imageClassName = refined
    ? size === "nav"
      ? "scale-[1.06]"
      : "scale-105"
    : size === "nav"
      ? "scale-[1.02]"
      : "scale-100";

  const wordmarkClassName =
    size === "nav"
      ? refined
        ? "text-[1.16rem] font-semibold tracking-[-0.03em] text-zinc-900 transition-colors group-hover:text-zinc-700 dark:text-white dark:group-hover:text-zinc-200"
        : "text-[1.05rem] font-semibold tracking-[-0.02em] text-zinc-900 dark:text-white"
      : refined
        ? "text-base font-semibold tracking-[-0.025em] text-zinc-900 dark:text-white"
        : "text-sm font-semibold tracking-tight text-zinc-900 dark:text-white";

  return (
    <Link href="/" className={`group inline-flex items-center ${gapClassName}`}>
      <SourceWeftBrandMark
        className={markClassName}
        imageClassName={imageClassName}
      />
      <span className={`font-brand ${wordmarkClassName}`}>SourceWeft</span>
    </Link>
  );
}
