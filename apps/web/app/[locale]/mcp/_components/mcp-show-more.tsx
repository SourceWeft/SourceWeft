"use client";

import { Children, useState, type ReactNode } from "react";

/**
 * A list that shows its first `initial` children and a "Show more" control for
 * the rest. The children are rendered on the server and the control only
 * reveals them, so showing more costs no request. No total is claimed: the
 * list holds what the catalog loaded, which is not necessarily all there is.
 */
export function McpShowMore({
  children,
  className,
  initial,
  label,
}: {
  children: ReactNode;
  className?: string;
  initial: number;
  label: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = Children.toArray(children);
  const hidden = items.length > initial && !expanded;
  return (
    <>
      <div className={className} data-show-more={hidden ? "collapsed" : "open"}>
        {hidden ? items.slice(0, initial) : items}
      </div>
      {hidden ? (
        <button
          className="mt-4 inline-flex h-9 items-center rounded-lg border border-zinc-300 bg-white/70 px-4 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-950 hover:text-zinc-950 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-200 dark:hover:border-white/40 dark:hover:text-white"
          onClick={() => setExpanded(true)}
          type="button"
        >
          {label}
        </button>
      ) : null}
    </>
  );
}
