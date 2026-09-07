import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronRight,
  MessageCircleQuestion,
} from "lucide-react";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  ASSISTANT_ACTIVITY_DETAIL_CLASS,
  ASSISTANT_ACTIVITY_ICON_CLASS,
  ASSISTANT_ACTIVITY_LABEL_CLASS,
  ASSISTANT_ACTIVITY_ROW_CLASS,
} from "./assistant-activity-layout";
import { getUserQuestionDisplay } from "./user-question-display";
import type { ToolCallRecord } from "./types";

export function UserQuestionToolCard({
  toolCall,
  defaultOpen,
  contentClassName,
  children,
}: {
  toolCall: ToolCallRecord;
  defaultOpen?: boolean;
  contentClassName?: string;
  children?: ReactNode;
}) {
  const display = getUserQuestionDisplay(toolCall);
  const openByDefault = defaultOpen ?? (display.waiting || display.failed);
  const [isOpen, setIsOpen] = useState(openByDefault);
  useEffect(() => setIsOpen(openByDefault), [openByDefault]);

  return (
    <div className="group text-muted-foreground transition-colors hover:text-foreground">
      <button
        aria-expanded={isOpen}
        className={ASSISTANT_ACTIVITY_ROW_CLASS}
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <span className={ASSISTANT_ACTIVITY_ICON_CLASS}>
          {display.failed ? (
            <AlertTriangle className="size-3.5 text-destructive" />
          ) : (
            <MessageCircleQuestion className="size-3.5 text-muted-foreground/75" />
          )}
        </span>
        <span className={ASSISTANT_ACTIVITY_LABEL_CLASS}>
          <span
            className="truncate text-[13px] text-foreground/80"
            title={display.title}
          >
            {display.title}
          </span>
          {display.waiting ? (
            <span className="text-xs text-muted-foreground/60">
              Waiting for your answer
            </span>
          ) : null}
          {display.failed ? (
            <span className="text-xs text-destructive">Failed</span>
          ) : null}
        </span>
        <span className="grid size-4 shrink-0 place-items-center">
          <ChevronRight
            className={cn(
              "size-3 text-muted-foreground/50 transition-transform",
              isOpen && "rotate-90",
            )}
          />
        </span>
      </button>
      {isOpen ? (
        <div className={cn(ASSISTANT_ACTIVITY_DETAIL_CLASS, contentClassName)}>
          {display.transcript ? (
            <p className="whitespace-pre-wrap break-words">
              {display.transcript}
            </p>
          ) : (
            <>
              {display.questions.map((question, index) => (
                <p className="whitespace-pre-wrap break-words" key={index}>
                  {question.question}
                </p>
              ))}
              {toolCall.status === "completed" && !display.waiting ? (
                <p>No answer provided</p>
              ) : null}
            </>
          )}
          {display.error ? (
            <p className="whitespace-pre-wrap break-words text-destructive">
              {display.error}
            </p>
          ) : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}
