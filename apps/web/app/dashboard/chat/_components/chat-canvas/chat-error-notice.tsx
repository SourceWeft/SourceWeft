import { AlertTriangle } from "lucide-react";

import { cn } from "@sourceweft/ui-web/lib/utils";

export type ChatErrorNoticeProps = {
  /** Optional bold heading, e.g. "Message failed". */
  title?: string;
  /** Primary error message. */
  message: string;
  /** Optional secondary code/detail line. */
  code?: string | null;
  /**
   * Compact treatment for inline/nested error surfaces (tool cards, pipelines).
   * Default is the full run-level banner treatment.
   */
  compact?: boolean;
  className?: string;
};

export function formatChatErrorMessage(message: string, code?: string | null) {
  const codePrefix = code ? `${code}:` : null;
  const withoutCode =
    codePrefix && message.startsWith(codePrefix)
      ? message.slice(codePrefix.length).trimStart()
      : message;
  return withoutCode.replace(
    /Provider returned invalid structured output(?: \(length=\d+, sha256=[a-f0-9]{64}\))?/giu,
    "The model did not return valid structured content",
  );
}

/**
 * The single, canonical error surface for the chat thread. Every red error
 * message in the conversation (run failure, tool failure, sandbox failure,
 * pipeline failure) should render through this component so the icon,
 * `destructive` color token, and layout stay consistent.
 */
export function ChatErrorNotice({
  title,
  message,
  code,
  compact = false,
  className,
}: ChatErrorNoticeProps) {
  const displayMessage = formatChatErrorMessage(message, code);

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border border-destructive/30 text-destructive",
        compact
          ? "bg-destructive/5 p-2 text-xs"
          : "bg-destructive/10 px-3 py-2 text-sm",
        className,
      )}
      role="alert"
    >
      <AlertTriangle
        className={cn("mt-0.5 shrink-0", compact ? "size-3.5" : "size-4")}
      />
      <div className={cn("min-w-0", compact ? "space-y-0.5" : "space-y-1")}>
        {title ? <p className="font-medium">{title}</p> : null}
        <p className="whitespace-pre-wrap break-words text-destructive/90">
          {displayMessage}
        </p>
        {code ? (
          <p
            className={cn(
              "text-destructive/70",
              compact ? undefined : "text-xs",
            )}
          >
            {code}
          </p>
        ) : null}
      </div>
    </div>
  );
}
