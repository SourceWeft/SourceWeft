import type { KeyboardEvent, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { RawImage } from "../../raw-image";

/**
 * The card a capability shows in the message stream for an artifact it is
 * producing.
 *
 * Every deliverable's card is the same object: thumbnail, title, description,
 * one primary action, a row of chips, and one line of pending/error copy. What
 * differs between them — whether the action downloads a file or opens a
 * preview, what the chips say, where the stage words come from — is entirely
 * wording and callbacks, so it all arrives as props.
 *
 * Nothing here knows a capability, an artifact type, or a payload shape; the
 * component that owns those decides them and hands down the result. Deriving
 * "which deliverable is this?" inside a shared component is exactly what this
 * file exists to make unnecessary.
 */

/** The tool call itself failed, so there is no card to show — just the reason. */
export function ArtifactBlockError({ message }: { message: string }) {
  return (
    <div className="max-w-xl rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}

export type ArtifactCardBadge = {
  /** Renders the chip as a link when set. */
  href?: string;
  label: string;
};

export type ArtifactCardAction = {
  disabled?: boolean;
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  title?: string;
};

export type ArtifactCardProps = {
  action: ArtifactCardAction;
  badges?: readonly ArtifactCardBadge[];
  description?: string | null;
  /** One line of failure copy, shown when `isError`. */
  errorText?: string | null;
  /** Shown in place of the thumbnail when there is no image and no spinner. */
  fallbackIcon: ReactNode;
  isError?: boolean;
  isPending?: boolean;
  /** Makes the whole card a button; omit to leave it inert. */
  onActivate?: () => void;
  /** One line of progress copy, shown when `isPending`. */
  pendingText?: string | null;
  thumbnailUrl?: string | null;
  title: string;
};

export function ArtifactCard({
  action,
  badges,
  description,
  errorText,
  fallbackIcon,
  isError = false,
  isPending = false,
  onActivate,
  pendingText,
  thumbnailUrl,
  title,
}: ArtifactCardProps) {
  const canActivate = Boolean(onActivate);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    onActivate?.();
  };

  return (
    <div
      aria-label={canActivate ? `Open artifact preview for ${title}` : undefined}
      className={cn(
        "relative isolate w-full max-w-xl rounded-lg border border-border bg-background shadow-sm outline-none transition-[background-color,border-color,box-shadow]",
        canActivate &&
          "cursor-pointer hover:border-foreground/25 hover:bg-accent/40 hover:shadow-md hover:shadow-foreground/5 focus-visible:border-primary/45 focus-visible:bg-accent/30 focus-visible:shadow-[0_10px_30px_-22px_hsl(var(--foreground)/0.5),0_0_0_1px_hsl(var(--primary)/0.18)] focus-visible:after:pointer-events-none focus-visible:after:absolute focus-visible:after:inset-0 focus-visible:after:rounded-[inherit] focus-visible:after:shadow-[inset_0_0_0_2px_hsl(var(--ring)/0.55)] focus-visible:after:content-['']",
      )}
      onClick={onActivate}
      onKeyDown={canActivate ? handleKeyDown : undefined}
      role={canActivate ? "button" : undefined}
      tabIndex={canActivate ? 0 : undefined}
    >
      <div className="flex items-start gap-3 p-3">
        <div className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted/60">
          {thumbnailUrl && !isPending && !isError ? (
            <RawImage
              alt={title}
              className="size-full object-cover"
              loading="lazy"
              src={thumbnailUrl}
            />
          ) : isPending ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : (
            fallbackIcon
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {title}
              </p>
              {description ? (
                <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              disabled={action.disabled}
              onClick={(event) => {
                event.stopPropagation();
                action.onClick();
              }}
              title={action.title}
              type="button"
            >
              {action.icon}
              {action.label}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            {(badges ?? []).map((badge) =>
              badge.href ? (
                <a
                  className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  href={badge.href}
                  key={badge.label}
                  onClick={(event) => event.stopPropagation()}
                  rel="noopener"
                >
                  {badge.label}
                </a>
              ) : (
                <span
                  className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5"
                  key={badge.label}
                >
                  {badge.label}
                </span>
              ),
            )}
            {isPending && pendingText ? <span>{pendingText}</span> : null}
          </div>
          {isError && errorText ? (
            <p className="mt-2 text-xs text-destructive">{errorText}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
