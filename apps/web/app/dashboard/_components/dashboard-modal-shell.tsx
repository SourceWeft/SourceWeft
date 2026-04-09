"use client";

import type * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { cn } from "@sourceweft/ui-web/lib/utils";

export function DashboardModalShell({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  contentClassName,
  actions,
  fullScreen = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  actions?: React.ReactNode;
  fullScreen?: boolean;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className={cn(
          fullScreen
            ? "fixed inset-0 z-50 grid h-dvh max-h-dvh w-full max-w-full rounded-none border-0 bg-card p-0 shadow-none"
            : "grid max-h-[calc(100svh-1.5rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-[24px] border border-border/90 bg-card p-0 shadow-[0_20px_60px_rgba(0,0,0,0.10)]",
          className,
        )}
      >
        <DialogHeader
          className={cn(
            "relative flex flex-row items-start justify-between gap-4 border-border/80 bg-linear-to-b from-card to-card/95 px-5 py-4 text-left",
            fullScreen ? "border-b" : "border-b",
          )}
        >
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-linear-to-r from-transparent via-border to-transparent" />
          <div className="min-w-0 flex-1 space-y-1 pr-14 sm:pr-16">
            <DialogTitle className="text-base font-semibold text-foreground">
              {title}
            </DialogTitle>
            {description ? (
              <DialogDescription className="text-xs text-muted-foreground">
                {description}
              </DialogDescription>
            ) : null}
          </div>
          {actions ? <div className="shrink-0 pr-8 sm:pr-10">{actions}</div> : null}
        </DialogHeader>
        <div
          className={cn(
            "min-h-0 overflow-y-auto px-5 py-4",
            fullScreen
              ? "bg-muted/5"
              : "bg-linear-to-b from-card via-card to-muted/10",
            contentClassName,
          )}
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function DashboardSection({
  title,
  eyebrow,
  meta,
  children,
  className,
  headerActions,
}: {
  title?: string;
  eyebrow?: string;
  meta?: string;
  children: React.ReactNode;
  className?: string;
  headerActions?: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-border/80 bg-background/95 p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)] backdrop-blur-sm",
        className,
      )}
    >
      {eyebrow || title || meta || headerActions ? (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {eyebrow ? (
              <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                {eyebrow}
              </p>
            ) : null}
            {title ? (
              <h3 className="mt-1 text-sm font-medium text-foreground">{title}</h3>
            ) : null}
            {meta ? (
              <p className="mt-1 text-xs text-muted-foreground">{meta}</p>
            ) : null}
          </div>
          {headerActions ? <div className="shrink-0">{headerActions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function DashboardMetaRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

export function DashboardEmbed({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border/70 bg-card/70 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
