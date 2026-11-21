"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { HttpClientError, type TableEstimateResponse } from "@sourceweft/sdk";
import { groundedErrorCodeSchema } from "@sourceweft/contracts/grounded-generation";
import { TABLE_LIMITS, type TableColumnInput } from "@sourceweft/contracts/table";
import {
  blankTableColumn,
  cleanColumns,
  ColumnEditor,
  columnsProblem,
  mergeSuggestedColumns,
} from "@sourceweft/builtin-tool-table/ui";
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
import { useTableTranslate } from "../artifact-preview/table-host";

/** Where the request goes: a new table in a thread, or the next version of one. */
export type TableGenerateTarget =
  | { kind: "generate"; threadId: string }
  | { kind: "regenerate"; threadId: string; artifactId: string };

export type TableGenerateSource = { id: string; title: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  target: TableGenerateTarget;
  /** The sources the dialog opens with; the person can remove some or add others. */
  sources: readonly TableGenerateSource[];
  /** Pre-fill (a regeneration passes the recipe's columns, ids included). */
  initialColumns?: readonly TableColumnInput[];
  initialInstruction?: string;
  onQueued?: (result: { artifactId: string; versionNo: number }) => void;
};

/** Waits for typing to pause before asking the server for the size. */
const ESTIMATE_DELAY_MS = 400;

/** Codes the request routes answer with that have their own table wording. */
const TABLE_REQUEST_CODES = new Set([
  "TABLE_TOO_MANY_RUNNING",
  "TABLE_NOT_READY",
  "TABLE_CONTENT_UNREADABLE",
  "TABLE_REGENERATION_IN_PROGRESS",
  "VALIDATION_ERROR",
  "THREAD_NOT_FOUND",
  "ARTIFACT_NOT_FOUND",
]);

type TableT = ReturnType<typeof useTranslations<"table">>;

/** The message for a failed table request, chosen by its API error code. */
function requestErrorMessage(
  t: TableT,
  error: unknown,
  fallback:
    "generate.errors.generic" | "generate.errors.suggestFailed" | "generate.estimate.failed",
) {
  const code = error instanceof HttpClientError ? error.code : null;
  if (code && groundedErrorCodeSchema.safeParse(code).success) {
    return t(`error.code.${code}` as Parameters<TableT>[0]);
  }
  if (code && TABLE_REQUEST_CODES.has(code)) {
    return t(`generate.errors.${code}` as Parameters<TableT>[0]);
  }
  return t(fallback);
}

type EstimateState =
  | { key: string; status: "ready"; value: TableEstimateResponse }
  | { key: string; status: "failed"; message: string };

/**
 * Generates a data table from sources, or regenerates one: the columns (typed,
 * suggested, or both), an optional instruction, and the size of the work
 * before anything is queued. A request that is too large never leaves the
 * dialog.
 */
export function TableGenerateDialog({
  open,
  onOpenChange,
  workspaceId,
  target,
  sources,
  initialColumns,
  initialInstruction,
  onQueued,
}: Props) {
  const t = useTranslations("table");
  const editorT = useTableTranslate();
  const [columns, setColumns] = useState<TableColumnInput[]>(() =>
    initialColumns ? [...initialColumns] : [blankTableColumn()],
  );
  const [instruction, setInstruction] = useState(initialInstruction ?? "");
  const [suggesting, setSuggesting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [estimate, setEstimate] = useState<EstimateState | null>(null);
  // A missing column or name is pointed out only once the person edits the
  // columns; the submit button stays off either way.
  const [columnsEdited, setColumnsEdited] = useState(false);
  const [sourceIds, setSourceIds] = useState<string[]>(() => sources.map((source) => source.id));
  const knownTitles = useMemo(
    () => new Map(sources.map((source) => [source.id, source.title])),
    [sources],
  );

  // Each opening starts from the pre-fill (or one blank column), never from the
  // last edit. Only the opening resets: a parent that re-renders with fresh
  // props while the dialog is open (the hub refreshing its sources) must not
  // undo what the person changed.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    setColumns(initialColumns ? [...initialColumns] : [blankTableColumn()]);
    setColumnsEdited(false);
    setSourceIds(sources.map((source) => source.id));
    setInstruction(initialInstruction ?? "");
    setEstimate(null);
  }, [open, initialColumns, initialInstruction, sources]);

  const trimmedInstruction = instruction.trim();
  const cells = sourceIds.length * columns.length;
  const columnProblem = columnsProblem(columns, TABLE_LIMITS.maxColumns);
  const problem = columnProblem
    ? columnProblem === "tooMany"
      ? t("generate.problems.tooMany", { max: TABLE_LIMITS.maxColumns })
      : t(`generate.problems.${columnProblem}`)
    : sourceIds.length === 0
      ? t("generate.problems.noSources")
      : sourceIds.length > TABLE_LIMITS.maxSources
        ? t("generate.problems.tooManySources", {
            max: TABLE_LIMITS.maxSources,
          })
        : cells > TABLE_LIMITS.maxCells
          ? t("generate.problems.tooManyCells", {
              sources: sourceIds.length,
              columns: columns.length,
              cells,
              max: TABLE_LIMITS.maxCells,
            })
          : null;

  const threadId = target.threadId;
  const estimateRequest = useMemo(
    () => ({
      threadId,
      sourceIds,
      columns: cleanColumns(columns),
      ...(trimmedInstruction ? { instruction: trimmedInstruction } : {}),
    }),
    [threadId, sourceIds, columns, trimmedInstruction],
  );
  const estimateKey = JSON.stringify(estimateRequest);
  const canEstimate = open && !problem;

  useEffect(() => {
    if (!canEstimate) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      contentClient
        .estimateTable(workspaceId, estimateRequest)
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

  async function suggest() {
    setSuggesting(true);
    try {
      const result = await contentClient.suggestTableColumns(workspaceId, {
        sourceIds,
        ...(trimmedInstruction ? { instruction: trimmedInstruction } : {}),
      });
      setColumns((existing) =>
        mergeSuggestedColumns(existing, result.columns, TABLE_LIMITS.maxColumns),
      );
    } catch (error) {
      toast.error(requestErrorMessage(t, error, "generate.errors.suggestFailed"));
    } finally {
      setSuggesting(false);
    }
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const queued =
        target.kind === "generate"
          ? await contentClient.generateTable(workspaceId, estimateRequest)
          : await contentClient.regenerateTable(workspaceId, target.artifactId, {
              sourceIds,
              columns: estimateRequest.columns,
              // Sent even when empty: leaving it out would keep the old instruction.
              instruction: trimmedInstruction,
            });
      toast.success(
        target.kind === "regenerate"
          ? t("generate.regenerating")
          : "reused" in queued && queued.reused
            ? t("generate.reused")
            : t("generate.started"),
      );
      onOpenChange(false);
      onQueued?.({
        artifactId: queued.artifactId,
        versionNo: queued.versionNo,
      });
    } catch (error) {
      toast.error(requestErrorMessage(t, error, "generate.errors.generic"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {target.kind === "regenerate" ? t("generate.regenerateTitle") : t("generate.title")}
          </DialogTitle>
          <DialogDescription>{t("generate.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid min-w-0 gap-4">
          <WorkspaceSourcePicker
            disabled={suggesting || submitting}
            enabled={open}
            knownTitles={knownTitles}
            labels={{
              label: t("generate.sources", { count: sourceIds.length }),
              addLabel: t("generate.addSource"),
              searchLabel: t("generate.searchSources"),
              emptyLabel: t("generate.noSources"),
              moreLabel: t("generate.moreResults"),
              limitLabel: t("generate.sourcesLimit", {
                max: TABLE_LIMITS.maxSources,
              }),
              untitled: t("generate.untitledSource"),
              unavailable: t("generate.unavailableSource"),
            }}
            limit={TABLE_LIMITS.maxSources}
            onChange={setSourceIds}
            value={sourceIds}
            workspaceId={workspaceId}
          />

          <div className="grid gap-1.5">
            <Label htmlFor="table-instruction">{t("generate.instruction")}</Label>
            <Textarea
              id="table-instruction"
              maxLength={TABLE_LIMITS.instructionChars}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder={t("generate.instructionPlaceholder")}
              rows={2}
              value={instruction}
            />
          </div>

          <section className="grid min-w-0 gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{t("generate.columns")}</p>
              <Button
                disabled={
                  suggesting ||
                  sourceIds.length === 0 ||
                  sourceIds.length > TABLE_LIMITS.maxSources ||
                  columns.length >= TABLE_LIMITS.maxColumns
                }
                onClick={() => void suggest()}
                size="sm"
                type="button"
                variant="outline"
              >
                {suggesting ? (
                  <Loader2 aria-hidden className="animate-spin" />
                ) : (
                  <Sparkles aria-hidden />
                )}
                {suggesting ? t("generate.suggesting") : t("generate.suggest")}
              </Button>
            </div>
            <ColumnEditor
              disabled={suggesting || submitting}
              max={TABLE_LIMITS.maxColumns}
              onChange={(next) => {
                setColumns(next);
                setColumnsEdited(true);
              }}
              showErrors={columnsEdited}
              t={editorT}
              value={columns}
            />
          </section>

          <div aria-live="polite" className="grid gap-1 text-sm">
            {problem ? (
              columnProblem === "none" || columnProblem === "nameMissing" ? (
                columnsEdited ? (
                  <p className="text-destructive">{problem}</p>
                ) : null
              ) : (
                <p className="text-destructive">{problem}</p>
              )
            ) : !current ? (
              <p className="text-muted-foreground">{t("generate.estimate.loading")}</p>
            ) : current.status === "failed" ? (
              <p className="text-destructive">{current.message}</p>
            ) : (
              <>
                <p className="text-muted-foreground">
                  {target.kind === "regenerate"
                    ? // The estimate cannot see the current version, so it
                      // counts every cell; a regeneration reuses unchanged ones.
                      t("generate.estimate.regenerateSummary", {
                        sources: current.value.sources,
                        columns: current.value.columns,
                      })
                    : t("generate.estimate.summary", {
                        sources: current.value.sources,
                        cells: current.value.cells,
                      })}
                </p>
                {current.value.skippedSources > 0 ? (
                  <p className="text-muted-foreground">
                    {t("generate.estimate.skipped", {
                      count: current.value.skippedSources,
                    })}
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
            {target.kind === "regenerate" ? t("generate.regenerateSubmit") : t("generate.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
