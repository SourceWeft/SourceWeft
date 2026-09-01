import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDot,
  XCircle,
} from "lucide-react";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { ChatErrorNotice } from "./chat-error-notice";

export type ArtifactPipelineStepView = {
  id: string;
  label: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  progress?: number;
  attempt?: number;
  maxAttempts?: number;
  errorMessage?: string;
  summary?: string;
  display?: string;
  logTail?: string[];
  metrics?: Record<string, number>;
};

function StepStatusIcon({
  status,
}: {
  status: ArtifactPipelineStepView["status"];
}) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="size-3.5 text-emerald-600" />;
    case "running":
      return <CircleDot className="size-3.5 text-primary" />;
    case "failed":
      return <XCircle className="size-3.5 text-destructive" />;
    default:
      return <Circle className="size-3.5 text-muted-foreground/45" />;
  }
}

function renderDisplayText(value: string) {
  // Lightweight markdown-ish rendering for stage display (titles + bold).
  return value.split("\n").map((line, index) => {
    const heading = line.match(/^#+\s+(.*)$/);
    if (heading) {
      return (
        <p className="mt-1 font-medium text-foreground" key={`h-${index}`}>
          {heading[1]}
        </p>
      );
    }
    const parts = line.split(/(\*\*[^*]+\*\*)/g).map((part, partIndex) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong
            className="font-medium text-foreground"
            key={`b-${partIndex}`}
          >
            {part.slice(2, -2)}
          </strong>
        );
      }
      return <span key={`t-${partIndex}`}>{part}</span>;
    });
    return (
      <p className="text-muted-foreground" key={`l-${index}`}>
        {parts}
      </p>
    );
  });
}

function PipelineStepRow({
  defaultOpen,
  errorCode,
  step,
}: {
  defaultOpen: boolean;
  errorCode?: string;
  step: ArtifactPipelineStepView;
}) {
  const hasDetails = Boolean(
    step.display ||
    (step.logTail && step.logTail.length > 0) ||
    step.errorMessage,
  );
  const [open, setOpen] = useState(defaultOpen && hasDetails);
  // Steps mount as pending and transition to running/failed later; auto-open
  // details on that transition (e.g. surface a failed stage's error) without
  // fighting a user who manually collapsed the row afterwards.
  useEffect(() => {
    if (defaultOpen && hasDetails) {
      setOpen(true);
    }
  }, [defaultOpen, hasDetails]);

  return (
    <li className="text-xs text-muted-foreground">
      <button
        className={cn(
          "flex w-full items-start gap-2 rounded-sm text-left",
          hasDetails && "hover:text-foreground",
        )}
        disabled={!hasDetails}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="mt-0.5 shrink-0">
          <StepStatusIcon status={step.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              step.status === "running" && "font-medium text-foreground",
              step.status === "failed" && "text-destructive",
              step.status === "completed" && "text-muted-foreground",
            )}
          >
            {step.label}
          </span>
          {step.summary ? (
            <span className="ml-1 text-muted-foreground/80">
              · {step.summary}
            </span>
          ) : null}
          {step.status === "running" ? (
            <span className="ml-1 text-primary">· Running</span>
          ) : null}
          {(step.status === "running" || step.status === "failed") &&
          typeof step.attempt === "number" &&
          typeof step.maxAttempts === "number" &&
          step.maxAttempts > 1 ? (
            <span className="ml-1 text-muted-foreground/70">
              · attempt {step.attempt}/{step.maxAttempts}
            </span>
          ) : null}
        </span>
        {hasDetails ? (
          <ChevronRight
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
        ) : null}
      </button>
      {open && hasDetails ? (
        <div className="mt-1.5 ml-5 space-y-1.5 border-l border-border/50 pl-3">
          {step.errorMessage ? (
            <ChatErrorNotice
              code={errorCode}
              compact
              message={step.errorMessage}
            />
          ) : null}
          {step.display ? (
            <div className="space-y-0.5 break-words">
              {renderDisplayText(step.display)}
            </div>
          ) : null}
          {step.logTail && step.logTail.length > 0 ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
              {step.logTail.join("\n")}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function ArtifactPipeline({
  activeStepId,
  className,
  errorCode,
  errorMessage,
  footerRight,
  mode = "live",
  status,
  steps,
  title,
}: {
  activeStepId?: string | null;
  className?: string;
  errorCode?: string;
  errorMessage?: string;
  footerRight?: string;
  mode?: "live" | "history";
  status: "pending" | "running" | "ready" | "failed";
  steps: ArtifactPipelineStepView[];
  title: string;
}) {
  const [historyOpen, setHistoryOpen] = useState(mode !== "history");
  // A failed step row auto-opens and already shows its own error, so the
  // pipeline-level error line would repeat it when the history is expanded.
  const errorShownByFailedStep =
    historyOpen &&
    Boolean(errorMessage) &&
    steps.some(
      (step) => step.status === "failed" && step.errorMessage === errorMessage,
    );

  return (
    <div
      className={cn(
        "space-y-2 rounded-md border border-border/60 p-3",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <button
          className={cn(
            "font-medium text-foreground/85",
            mode === "history" && "hover:text-foreground",
          )}
          disabled={mode !== "history"}
          onClick={() => setHistoryOpen((value) => !value)}
          type="button"
        >
          {title}
          {mode === "history" ? (
            <ChevronRight
              className={cn(
                "ml-1 inline size-3.5 align-[-2px] transition-transform",
                historyOpen && "rotate-90",
              )}
            />
          ) : null}
        </button>
        {footerRight ? (
          <span className="tabular-nums text-muted-foreground">
            {footerRight}
          </span>
        ) : null}
      </div>
      {historyOpen ? (
        <ol className="space-y-1.5">
          {steps.map((step) => (
            <PipelineStepRow
              defaultOpen={
                step.status === "running" ||
                step.id === activeStepId ||
                step.status === "failed"
              }
              errorCode={step.status === "failed" ? errorCode : undefined}
              key={step.id}
              step={step}
            />
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">
          {steps.filter((step) => step.status === "completed").length}/
          {steps.length} stages completed
        </p>
      )}
      {status === "failed" && errorMessage && !errorShownByFailedStep ? (
        <ChatErrorNotice code={errorCode} compact message={errorMessage} />
      ) : null}
    </div>
  );
}
