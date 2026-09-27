"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@sourceweft/ui-web/lib/utils";

/**
 * Folds a long README to about one screen, with a control to read the rest.
 *
 * Whether it folds (`collapsible`) is decided on the server from the source
 * (isLongMcpReadme), so the first paint is already folded and hydrating moves
 * nothing. The control sits over the faded bottom of the fold, out of the flow:
 * when the page finds the README fits after all, it drops the control without
 * anything below it shifting.
 *
 * Folded text stays in the accessibility tree, and keyboard focus reaching a
 * link inside the fold unfolds it. The control is one element in both states,
 * so it keeps focus when it is pressed.
 */
export function McpReadmeCollapse({
  children,
  collapsible,
}: {
  children: ReactNode;
  collapsible: boolean;
}) {
  const t = useTranslations("mcp.readme");
  const regionId = useId();
  const regionRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const revealControlRef = useRef(false);
  const [expanded, setExpanded] = useState(false);
  // Assumed until measured, which is what the server renders.
  const [overflowing, setOverflowing] = useState(true);
  const folded = collapsible && !expanded;

  // A ResizeObserver reports once as soon as it observes, then on every change
  // (a web font arriving, a narrower window). The folded box stops growing at
  // its cap, so its content is observed too.
  useEffect(() => {
    const region = regionRef.current;
    if (!folded || !region || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      setOverflowing(region.scrollHeight > region.clientHeight + 1),
    );
    observer.observe(region);
    for (const child of region.children) observer.observe(child);
    return () => observer.disconnect();
  }, [folded]);

  // Folding a README read to its end leaves the reader far below it: bring the
  // control they just pressed back into view.
  useEffect(() => {
    if (!revealControlRef.current) return;
    revealControlRef.current = false;
    buttonRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [folded]);

  if (!collapsible) return <>{children}</>;

  const hidesText = folded && overflowing;

  function unfoldForKeyboardFocus(event: FocusEvent<HTMLDivElement>) {
    if (!hidesText) return;
    let keyboard = true;
    try {
      keyboard = event.target.matches(":focus-visible");
    } catch {
      // A browser without :focus-visible: unfold for any focus.
    }
    if (keyboard) setExpanded(true);
  }

  return (
    <div className="relative">
      <div
        className={cn(
          folded && "max-h-[75svh] overflow-hidden",
          hidesText &&
            "[mask-image:linear-gradient(to_bottom,#000_calc(100%_-_7rem),transparent)]",
        )}
        data-state={folded ? "collapsed" : "expanded"}
        id={regionId}
        onFocus={unfoldForKeyboardFocus}
        ref={regionRef}
      >
        {children}
      </div>
      <div
        className={cn(
          "flex justify-center",
          folded ? "absolute inset-x-0 bottom-0 pb-2" : "mt-5",
          folded && !overflowing && "hidden",
        )}
      >
        <button
          aria-controls={regionId}
          aria-expanded={!folded}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-950 shadow-sm transition-colors hover:border-zinc-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-950 dark:border-white/15 dark:bg-zinc-900 dark:text-white dark:hover:border-white/40 dark:focus-visible:outline-white"
          onClick={() => {
            revealControlRef.current = !folded;
            setExpanded(folded);
          }}
          ref={buttonRef}
          type="button"
        >
          {folded ? t("showMore") : t("showLess")}
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 transition-transform",
              !folded && "rotate-180",
            )}
          />
        </button>
      </div>
    </div>
  );
}
