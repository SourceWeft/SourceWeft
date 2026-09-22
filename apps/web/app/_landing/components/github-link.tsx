"use client";

import { ArrowUpRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { GitHubIcon } from "../../_components/brand-icons";

export function GitHubLink({
  iconOnly = false,
  className = "",
  onClick,
}: {
  iconOnly?: boolean;
  className?: string;
  onClick?: () => void;
}) {
  const t = useTranslations("header");

  return (
    <a
      href="https://github.com/SourceWeft/SourceWeft"
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t("githubRepository")}
      title={t("githubRepository")}
      onClick={onClick}
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-lg text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white ${iconOnly ? "size-8" : "px-3 py-2"} ${className}`}
    >
      <GitHubIcon aria-hidden="true" className="size-4" />
      {!iconOnly && (
        <>
          <span>GitHub</span>
          <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </>
      )}
    </a>
  );
}
