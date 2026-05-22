"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

type CopyState = "idle" | "copied" | "failed";

export function CopyShareUrlButton({ url }: { url: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCopyState("idle");
    }, 1600);

    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  async function copyUrl() {
    if (!navigator.clipboard) {
      setCopyState("failed");
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  const isCopied = copyState === "copied";
  const statusText =
    copyState === "failed" ? "Copy failed" : isCopied ? "Copied" : "Copy";

  return (
    <button
      aria-label={`Copy shareable URL: ${url}`}
      className="group flex w-full items-start justify-between gap-3 rounded-lg border border-zinc-300 bg-white/55 px-4 py-3 text-left shadow-[0_12px_34px_rgba(39,39,42,0.06)] transition-colors hover:border-zinc-950/35 hover:bg-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-950 dark:border-white/10 dark:bg-white/[0.04] dark:shadow-[0_12px_34px_rgba(0,0,0,0.22)] dark:hover:border-white/30 dark:hover:bg-white/[0.07] dark:focus-visible:outline-white"
      onClick={() => void copyUrl()}
      type="button"
    >
      <span className="min-w-0 break-all font-mono text-xs leading-6 text-zinc-700 dark:text-zinc-200">
        {url}
      </span>
      <span
        aria-live="polite"
        className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 text-xs font-medium text-zinc-600 transition-colors group-hover:border-zinc-400 dark:border-white/10 dark:bg-white/[0.05] dark:text-zinc-300 dark:group-hover:border-white/25"
      >
        {isCopied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
        {statusText}
      </span>
    </button>
  );
}
