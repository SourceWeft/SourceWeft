"use client";

import { useState } from "react";
import {
  CircleStopIcon,
  MessageCircleQuestionIcon,
  SendHorizontalIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { AgentQuestionItem } from "@sourceweft/contracts";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Checkbox } from "@sourceweft/ui-web/components/ui/checkbox";
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import { cn } from "@sourceweft/ui-web/lib/utils";
import type { UserQuestionItem } from "./tool-confirmation-state";

/**
 * Renderer for proactive `askUser` questions. Branched from
 * `tool-confirmation.tsx` (it shares the intervention bar slot and the resume
 * route) but a question is not an approval: instead of a decision it collects one
 * positional free-text/selection answer per question and resumes with
 * `{ decisions: [], askUser: { status, answers } }`. See
 * `docs/architecture/proactive-ask-user.md`.
 */

export type UserQuestionAnswer =
  { status: "answered"; answers: string[] } | { status: "cancelled" };

const OTHER_LABEL = "Other…";

type QuestionDraft = {
  /** Selected choice label for single-select multiple_choice; null when none. */
  choice: string | null;
  /** Whether the "Other…" option is the active single-select choice. */
  otherSelected: boolean;
  /** Selected choice labels for multiSelect multiple_choice. */
  multi: string[];
  /** Free-text for the always-present "Other…" affordance. */
  otherText: string;
  /** Answer for `type:"text"` questions. */
  text: string;
};

function createDraft(): QuestionDraft {
  return {
    choice: null,
    otherSelected: false,
    multi: [],
    otherText: "",
    text: "",
  };
}

function isRequired(question: AgentQuestionItem) {
  return question.required !== false;
}

/** Collapse a draft to the single positional answer string the backend expects. */
function draftAnswer(
  question: AgentQuestionItem,
  draft: QuestionDraft,
): string {
  if (question.type === "text") {
    return draft.text.trim();
  }
  const otherText = draft.otherText.trim();
  if (question.multiSelect) {
    const labels = [...draft.multi];
    if (otherText.length > 0) {
      labels.push(otherText);
    }
    return labels.join(", ");
  }
  if (draft.otherSelected) {
    return otherText;
  }
  return draft.choice ?? "";
}

function hasAnswer(question: AgentQuestionItem, draft: QuestionDraft) {
  return draftAnswer(question, draft).length > 0;
}

function UserQuestionPanel({
  item,
  onSettled,
}: {
  item: UserQuestionItem;
  onSettled: (input: {
    answer: UserQuestionAnswer;
    item: UserQuestionItem;
  }) => void;
}) {
  const questions = item.question.questions;
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
    questions.map(() => createDraft()),
  );
  const [showErrors, setShowErrors] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  function updateDraft(
    index: number,
    updater: (draft: QuestionDraft) => QuestionDraft,
  ) {
    setDrafts((previous) =>
      previous.map((draft, i) => (i === index ? updater(draft) : draft)),
    );
  }

  function toggleMultiChoice(index: number, label: string, checked: boolean) {
    updateDraft(index, (draft) => ({
      ...draft,
      multi: checked
        ? [...draft.multi.filter((value) => value !== label), label]
        : draft.multi.filter((value) => value !== label),
    }));
  }

  function handleSubmit() {
    const firstMissing = questions.findIndex(
      (question, index) =>
        isRequired(question) &&
        !hasAnswer(question, drafts[index] ?? createDraft()),
    );
    if (firstMissing >= 0) {
      setShowErrors(true);
      toast.error("Please answer the required question(s) before sending.");
      return;
    }
    const answers = questions.map((question, index) =>
      draftAnswer(question, drafts[index] ?? createDraft()),
    );
    setSubmitted(true);
    onSettled({ answer: { status: "answered", answers }, item });
  }

  function handleCancel() {
    setSubmitted(true);
    onSettled({ answer: { status: "cancelled" }, item });
  }

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-3 shadow-sm">
      <div className="flex flex-col gap-4">
        {questions.map((question, index) => {
          const draft = drafts[index] ?? createDraft();
          const required = isRequired(question);
          const unanswered = required && !hasAnswer(question, draft);
          const invalid = showErrors && unanswered;
          return (
            <div
              className="flex flex-col gap-2"
              key={`${item.question.id}:${index}`}
            >
              <div className="flex items-start gap-2">
                <MessageCircleQuestionIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0 space-y-1">
                  {question.header ? (
                    <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {question.header}
                    </span>
                  ) : null}
                  <p className="text-sm font-medium text-foreground">
                    {question.question}
                    {required ? null : (
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        (optional)
                      </span>
                    )}
                  </p>
                </div>
              </div>

              {question.type === "multiple_choice" ? (
                <div className="flex flex-col gap-2 pl-6">
                  {question.multiSelect ? (
                    <div className="flex flex-col gap-1.5">
                      {(question.choices ?? []).map((choice) => {
                        const checked = draft.multi.includes(choice.label);
                        return (
                          <label
                            className="flex cursor-pointer items-start gap-2 text-sm text-foreground"
                            key={choice.label}
                          >
                            <Checkbox
                              checked={checked}
                              disabled={submitted}
                              onCheckedChange={(next) =>
                                toggleMultiChoice(
                                  index,
                                  choice.label,
                                  next === true,
                                )
                              }
                            />
                            <span className="min-w-0">
                              <span className="block">{choice.label}</span>
                              {choice.description ? (
                                <span className="block text-xs text-muted-foreground">
                                  {choice.description}
                                </span>
                              ) : null}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {(question.choices ?? []).map((choice) => {
                        const selected =
                          !draft.otherSelected && draft.choice === choice.label;
                        return (
                          <Button
                            className="h-8 px-3 text-sm"
                            disabled={submitted}
                            key={choice.label}
                            onClick={() =>
                              updateDraft(index, (current) => ({
                                ...current,
                                choice: choice.label,
                                otherSelected: false,
                              }))
                            }
                            type="button"
                            variant={selected ? "default" : "outline"}
                            {...(choice.description
                              ? { title: choice.description }
                              : {})}
                          >
                            {choice.label}
                          </Button>
                        );
                      })}
                      <Button
                        className="h-8 px-3 text-sm"
                        disabled={submitted}
                        onClick={() =>
                          updateDraft(index, (current) => ({
                            ...current,
                            choice: null,
                            otherSelected: true,
                          }))
                        }
                        type="button"
                        variant={draft.otherSelected ? "default" : "outline"}
                      >
                        {OTHER_LABEL}
                      </Button>
                    </div>
                  )}

                  {question.multiSelect || draft.otherSelected ? (
                    <Textarea
                      aria-label="Other answer"
                      className="min-h-9 text-sm"
                      disabled={submitted}
                      onChange={(event) =>
                        updateDraft(index, (current) => ({
                          ...current,
                          otherText: event.target.value,
                        }))
                      }
                      placeholder={
                        question.multiSelect
                          ? "Other… (optional free text)"
                          : "Type your answer"
                      }
                      value={draft.otherText}
                    />
                  ) : null}
                </div>
              ) : (
                <div className="pl-6">
                  <Textarea
                    aria-label="Answer"
                    className={cn(
                      "min-h-9 text-sm",
                      invalid ? "border-destructive" : undefined,
                    )}
                    disabled={submitted}
                    onChange={(event) =>
                      updateDraft(index, (current) => ({
                        ...current,
                        text: event.target.value,
                      }))
                    }
                    placeholder="Type your answer"
                    value={draft.text}
                  />
                </div>
              )}

              {invalid ? (
                <p className="pl-6 text-xs text-destructive">
                  This question is required.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          className="h-8 px-3 text-sm"
          disabled={submitted}
          onClick={handleCancel}
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          className="h-8 gap-1.5 px-3 text-sm"
          disabled={submitted}
          onClick={handleSubmit}
          type="button"
        >
          <SendHorizontalIcon className="size-3.5" />
          {submitted ? "Sending…" : "Send answer"}
        </Button>
      </div>
    </div>
  );
}

export function UserQuestionInterventionBar({
  className,
  items,
  onSettled,
  onStopWaiting,
}: {
  className?: string;
  items?: UserQuestionItem[];
  onSettled: (input: {
    answer: UserQuestionAnswer;
    item: UserQuestionItem;
  }) => void;
  onStopWaiting?: () => void;
}) {
  if (!items || items.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "border-t border-border/70 bg-background/95 px-4 py-3 shadow-[0_-8px_24px_hsl(var(--background)/0.9)] backdrop-blur",
        className,
      )}
    >
      <div className="mx-auto w-full max-w-4xl space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            The assistant needs your input
          </span>
          {onStopWaiting ? (
            <button
              aria-label="Dismiss question"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground shadow-sm transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/20 disabled:opacity-60"
              onClick={onStopWaiting}
              title="Dismiss question"
              type="button"
            >
              <CircleStopIcon className="size-3.5" />
              End
            </button>
          ) : null}
        </div>
        {items.map((item) => (
          <UserQuestionPanel
            item={item}
            key={item.question.id}
            onSettled={onSettled}
          />
        ))}
      </div>
    </div>
  );
}
