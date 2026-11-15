import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@sourceweft/ui-web/lib/utils";

/**
 * The pieces every admin section is built from, so a heading, a loading line,
 * an empty queue and a failure look the same on every page.
 */

/** A page's title block. `level={2}` is for a second block on the same page. */
export function AdminHeader({
  title,
  description,
  actions,
  level = 1,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  level?: 1 | 2;
  className?: string;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <Heading
          className={cn(
            "font-semibold tracking-tight",
            level === 1 ? "text-2xl" : "text-lg",
          )}
        >
          {title}
        </Heading>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Something went wrong; `action` is usually a retry button. */
export function AdminError({
  children,
  action,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive",
        className,
      )}
      role="alert"
    >
      <AlertTriangle aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

export function AdminLoading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("flex items-center gap-2 py-6 text-sm text-muted-foreground", className)}>
      <Loader2 aria-hidden className="size-4 animate-spin" />
      {children}
    </p>
  );
}

/** Nothing to show. `done` marks an empty work queue, which is good news. */
export function AdminEmpty({
  children,
  done = false,
  className,
}: {
  children: ReactNode;
  done?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-12 text-center text-sm text-muted-foreground",
        className,
      )}
    >
      {done ? <CheckCircle2 aria-hidden className="size-6 text-emerald-500" /> : null}
      <p>{children}</p>
    </div>
  );
}

/** The bordered box a list of rows sits in. */
export function AdminList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("divide-y overflow-hidden rounded-xl border", className)}>{children}</div>
  );
}
