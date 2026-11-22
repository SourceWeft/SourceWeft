"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { HttpClientError, type StudyEstimateResponse } from "@sourceweft/sdk";
import { groundedErrorCodeSchema } from "@sourceweft/contracts/grounded-generation";
import {
  STUDY_DIFFICULTIES,
  STUDY_LIMITS,
  STUDY_SIZE_COUNTS,
  STUDY_SIZES,
  type StudyArtifactType,
  type StudyDifficulty,
  type StudyOptions,
  type StudySize,
} from "@sourceweft/contracts/study";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sourceweft/ui-web/components/ui/dialog";
import { Label } from "@sourceweft/ui-web/components/ui/label";
import { Textarea } from "@sourceweft/ui-web/components/ui/textarea";
import { contentClient } from "../../../../../lib/sdk";
import { WorkspaceSourcePicker } from "../../../_components/resource-picker";

/** Where the request goes: a new study set in a thread, or the next version of one. */
export type StudyGenerateTarget =
  | { kind: "generate"; threadId: string }
  | { kind: "regenerate"; threadId: string; artifactId: string };

export type StudyGenerateSource = { id: string; title: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  artifactType: StudyArtifactType;
  target: StudyGenerateTarget;
  /**
   * The sources the dialog opens with. A new set lets the person remove some
   * or add others; a regeneration keeps the current version's sources.
   */
  sources: readonly StudyGenerateSource[];
  /** Pre-fill (a regeneration passes the current version's recipe). */
  initialOptions?: StudyOptions;
  onQueued?: (result: { artifactId: string; versionNo: number }) => void;
};

/** Waits for typing to pause before asking the server for the size. */
const ESTIMATE_DELAY_MS = 400;

/**
 * Output languages offered besides "same as the sources", by their own names.
 * A recipe's language outside this list is offered too.
 */
const LANGUAGE_CHOICES: readonly { tag: string; name: string }[] = [
  { tag: "en", name: "English" },
  { tag: "zh-CN", name: "简体中文" },
  { tag: "zh-TW", name: "繁體中文" },
  { tag: "ja", name: "日本語" },
  { tag: "ko", name: "한국어" },
  { tag: "es", name: "Español" },
  { tag: "fr", name: "Français" },
  { tag: "de", name: "Deutsch" },
  { tag: "pt", name: "Português" },
];

/** Codes the request routes answer with that have their own study wording. */
const STUDY_REQUEST_CODES = new Set([
  "STUDY_TOO_MANY_RUNNING",
  "STUDY_NOT_READY",
  "STUDY_CONTENT_UNREADABLE",
  "STUDY_REGENERATION_IN_PROGRESS",
  "VALIDATION_ERROR",
  "THREAD_NOT_FOUND",
  "ARTIFACT_NOT_FOUND",
]);

type StudyT = ReturnType<typeof useTranslations<"study">>;

/** The message for a failed study request, chosen by its API error code. */
function requestErrorMessage(
  t: StudyT,
  error: unknown,
  fallback: "generate.errors.generic" | "generate.estimate.failed",
) {
  const code = error instanceof HttpClientError ? error.code : null;
  if (code && groundedErrorCodeSchema.safeParse(code).success) {
    return t(`error.code.${code}` as Parameters<StudyT>[0]);
  }
  if (code && STUDY_REQUEST_CODES.has(code)) {
    return t(`generate.errors.${code}` as Parameters<StudyT>[0]);
  }
  return t(fallback);
}

/** The size step whose count is nearest to `count` (a recipe that named a count). */
function nearestSize(type: StudyArtifactType, count: number): StudySize {
  let best: StudySize = "standard";
  for (const size of STUDY_SIZES) {
    if (
      Math.abs(STUDY_SIZE_COUNTS[type][size] - count) <
      Math.abs(STUDY_SIZE_COUNTS[type][best] - count)
    ) {
      best = size;
    }
  }
  return best;
}

type Form = {
  size: StudySize;
  /** The size was changed in this dialog (a recipe's explicit count gives way). */
  sizeTouched: boolean;
  difficulty: StudyDifficulty;
  focus: string;
  /** BCP 47 tag; empty follows the sources. */
  language: string;
};

function initialForm(type: StudyArtifactType, options: StudyOptions | undefined): Form {
  return {
    size:
      options?.size ??
      (options?.count !== undefined ? nearestSize(type, options.count) : "standard"),
    sizeTouched: false,
    difficulty: options?.difficulty ?? "mixed",
    focus: options?.focus ?? "",
    language: options?.language ?? "",
  };
}

/**
 * The options a request sends. A recipe made with an exact count (the chat
 * tool can ask for one) keeps it until the person picks a size here; then the
 * size's count replaces it, since a regeneration keeps any option it is not
 * sent.
 */
function studyRequestOptions(
  type: StudyArtifactType,
  form: Form,
  recipe: StudyOptions | undefined,
): StudyOptions {
  const focus = form.focus.trim();
  const recipeCount = recipe?.count;
  return {
    size: form.size,
    ...(recipeCount !== undefined
      ? { count: form.sizeTouched ? STUDY_SIZE_COUNTS[type][form.size] : recipeCount }
      : {}),
    // A mind map has no difficulty.
    ...(type === "mindmap" ? {} : { difficulty: form.difficulty }),
    ...(form.language ? { language: form.language } : {}),
    ...(focus ? { focus } : {}),
  };
}

type EstimateState =
  | { key: string; status: "ready"; value: StudyEstimateResponse }
  | { key: string; status: "failed"; message: string };

function Choices<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <p className="text-sm font-medium">{label}</p>
      <div aria-label={label} className="flex flex-wrap gap-1.5" role="group">
        {options.map((option) => (
          <Button
            aria-pressed={value === option.value}
            disabled={disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            size="sm"
            type="button"
            variant={value === option.value ? "secondary" : "outline"}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * Generates flashcards, a quiz or a mind map from sources, or regenerates one
 * ("adjust and regenerate", pre-filled from the current version's recipe):
 * size, difficulty, an optional focus and the output language, with the size
 * of the work checked before anything is queued. A request too large for one
 * generation never leaves the dialog.
 */
export function StudyGenerateDialog({
  open,
  onOpenChange,
  workspaceId,
  artifactType,
  target,
  sources,
  initialOptions,
  onQueued,
}: Props) {
  const t = useTranslations("study");
  const [form, setForm] = useState<Form>(() => initialForm(artifactType, initialOptions));
  const [sourceIds, setSourceIds] = useState<string[]>(() => sources.map((source) => source.id));
  const [submitting, setSubmitting] = useState(false);
  const [estimate, setEstimate] = useState<EstimateState | null>(null);
  const knownTitles = useMemo(
    () => new Map(sources.map((source) => [source.id, source.title])),
    [sources],
  );
  const regenerating = target.kind === "regenerate";

  // Each opening starts from the pre-fill, never from the last edit. Only the
  // opening resets: a parent that re-renders with fresh props while the
  // dialog is open (the hub refreshing its sources) must not undo edits.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    setForm(initialForm(artifactType, initialOptions));
    setSourceIds(sources.map((source) => source.id));
    setEstimate(null);
  }, [open, artifactType, initialOptions, sources]);

  const focusTooLong = form.focus.trim().length > STUDY_LIMITS.focusChars;
  const problem = focusTooLong
    ? t("generate.focus.tooLong", { max: STUDY_LIMITS.focusChars })
    : sourceIds.length === 0
      ? t("generate.problems.noSources")
      : sourceIds.length > STUDY_LIMITS.maxSources
        ? t("generate.problems.tooManySources", { max: STUDY_LIMITS.maxSources })
        : null;

  const threadId = target.threadId;
  const options = useMemo(
    () => studyRequestOptions(artifactType, form, initialOptions),
    [artifactType, form, initialOptions],
  );
  const estimateRequest = useMemo(
    () => ({ threadId, artifactType, sourceIds, options }),
    [threadId, artifactType, sourceIds, options],
  );
  const estimateKey = JSON.stringify(estimateRequest);
  const canEstimate = open && !problem;

  useEffect(() => {
    if (!canEstimate) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      contentClient
        .estimateStudy(workspaceId, estimateRequest)
        .then((value) => {
          if (!cancelled) setEstimate({ key: estimateKey, status: "ready", value });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setEstimate({
            key: estimateKey,
            status: "failed",
            message: requestErrorMessage(t, error, "generate.estimate.failed"),
          });
        });
    }, ESTIMATE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `estimateKey` stands for `estimateRequest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEstimate, estimateKey, workspaceId, t]);

  const current = !problem && estimate?.key === estimateKey ? estimate : null;
  const canSubmit = !submitting && current?.status === "ready" && !current.value.exceedsLimit;

  function update(next: Partial<Form>) {
    setForm((existing) => ({ ...existing, ...next }));
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const queued =
        target.kind === "generate"
          ? await contentClient.generateStudyArtifact(workspaceId, estimateRequest)
          : await contentClient.regenerateStudyArtifact(workspaceId, target.artifactId, {
              options,
              // Sent even when empty: leaving it out would keep the old focus.
              focus: form.focus.trim(),
            });
      toast.success(
        regenerating
          ? t("generate.regenerating")
          : "reused" in queued && queued.reused
            ? t("generate.reused")
            : t("generate.started"),
      );
      onOpenChange(false);
      onQueued?.({ artifactId: queued.artifactId, versionNo: queued.versionNo });
    } catch (error) {
      toast.error(requestErrorMessage(t, error, "generate.errors.generic"));
    } finally {
      setSubmitting(false);
    }
  }

  const languageChoices = LANGUAGE_CHOICES.some((choice) => choice.tag === form.language)
    ? LANGUAGE_CHOICES
    : form.language
      ? [...LANGUAGE_CHOICES, { tag: form.language, name: form.language }]
      : LANGUAGE_CHOICES;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {regenerating
              ? t("generate.regenerateTitle")
              : t(`generate.title.${artifactType}`)}
          </DialogTitle>
          <DialogDescription>{t(`generate.description.${artifactType}`)}</DialogDescription>
        </DialogHeader>

        <div className="grid min-w-0 gap-4">
          {regenerating ? (
            <p className="text-sm text-muted-foreground">
              {t("generate.regenerateSources", { count: sourceIds.length })}
            </p>
          ) : (
            <WorkspaceSourcePicker
              disabled={submitting}
              enabled={open}
              knownTitles={knownTitles}
              labels={{
                label: t("generate.sources", { count: sourceIds.length }),
                addLabel: t("generate.addSource"),
                searchLabel: t("generate.searchSources"),
                emptyLabel: t("generate.noSources"),
                moreLabel: t("generate.moreResults"),
                limitLabel: t("generate.sourcesLimit", { max: STUDY_LIMITS.maxSources }),
                untitled: t("generate.untitledSource"),
                unavailable: t("generate.unavailableSource"),
              }}
              limit={STUDY_LIMITS.maxSources}
              onChange={setSourceIds}
              value={sourceIds}
              workspaceId={workspaceId}
            />
          )}

          <Choices
            disabled={submitting}
            label={t("generate.size.label")}
            onChange={(size) => update({ size, sizeTouched: true })}
            options={STUDY_SIZES.map((size) => ({
              value: size,
              label: t(`generate.size.${artifactType}`, {
                size: t(`generate.size.${size}`),
                // The chosen step names what is sent: a recipe's exact count
                // until another size is picked.
                count:
                  size === form.size && !form.sizeTouched && options.count !== undefined
                    ? options.count
                    : STUDY_SIZE_COUNTS[artifactType][size],
              }),
            }))}
            value={form.size}
          />

          {artifactType === "mindmap" ? null : (
            <Choices
              disabled={submitting}
              label={t("generate.difficulty.label")}
              onChange={(difficulty) => update({ difficulty })}
              options={STUDY_DIFFICULTIES.map((difficulty) => ({
                value: difficulty,
                label: t(`generate.difficulty.${difficulty}`),
              }))}
              value={form.difficulty}
            />
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="study-focus">{t("generate.focus.label")}</Label>
            <Textarea
              aria-invalid={focusTooLong || undefined}
              disabled={submitting}
              id="study-focus"
              maxLength={STUDY_LIMITS.focusChars}
              onChange={(event) => update({ focus: event.target.value })}
              placeholder={t("generate.focus.placeholder")}
              rows={2}
              value={form.focus}
            />
            <p className="text-right text-xs text-muted-foreground tabular-nums">
              {t("generate.focus.counter", {
                used: form.focus.trim().length,
                max: STUDY_LIMITS.focusChars,
              })}
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="study-language">{t("generate.language.label")}</Label>
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              disabled={submitting}
              id="study-language"
              onChange={(event) => update({ language: event.target.value })}
              value={form.language}
            >
              <option value="">{t("generate.language.follow")}</option>
              {languageChoices.map((choice) => (
                <option key={choice.tag} lang={choice.tag} value={choice.tag}>
                  {choice.name}
                </option>
              ))}
            </select>
          </div>

          <div aria-live="polite" className="grid gap-1 text-sm">
            {problem ? (
              <p className="text-destructive">{problem}</p>
            ) : !current ? (
              <p className="text-muted-foreground">{t("generate.estimate.loading")}</p>
            ) : current.status === "failed" ? (
              <p className="text-destructive">{current.message}</p>
            ) : (
              <>
                <p className="text-muted-foreground">
                  {t(`generate.estimate.summary.${artifactType}`, {
                    count: current.value.maxItems,
                    sources: sourceIds.length,
                  })}
                </p>
                {current.value.mode === "mapreduce" && !current.value.exceedsLimit ? (
                  <p className="text-muted-foreground">
                    {t("generate.estimate.parts", { groups: current.value.groups })}
                  </p>
                ) : null}
                {current.value.exceedsLimit ? (
                  <p className="text-destructive">{t("generate.estimate.exceedsLimit")}</p>
                ) : null}
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            {t("generate.cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()} type="button">
            {submitting ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {regenerating ? t("generate.regenerateSubmit") : t("generate.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
