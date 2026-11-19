"use client";

import { useEffect, useId, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Columns3,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type { TableContent, TableFreshness, TableRow } from "@sourceweft/contracts/table";
import {
  GroundedHostProvider,
  StaleBanner,
} from "@sourceweft/grounded-generation/ui";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { TableValueCell } from "./table-cell";
import {
  type TableVersionRef,
  useGroundedHostFor,
  useTableHost,
} from "./table-host";
import {
  nextSort,
  readHiddenColumns,
  rowFreshness,
  SOURCE_COLUMN_ID,
  sortRows,
  visibleColumns,
  writeHiddenColumns,
  type SortState,
} from "./table-model";

const NO_VERSION: TableVersionRef = {
  workspaceId: "",
  artifactId: "",
  artifactVersionId: null,
};

const HEADER_CELL =
  "sticky top-0 z-20 border-b border-r bg-muted px-3 py-2 text-left text-xs font-medium text-muted-foreground";

function SortIcon({ direction }: { direction: SortState["direction"] | null }) {
  const Icon =
    direction === "asc" ? ArrowUp : direction === "desc" ? ArrowDown : ArrowUpDown;
  return (
    <Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", direction ? "text-foreground" : "opacity-50")}
    />
  );
}

/**
 * The generated table: one row per source with the source title first, one
 * column per question, each answer a cell that opens its source quote.
 *
 * It scrolls inside its own container, never the page, and the title column
 * stays in view while the answers scroll. `interactive === false` (the public
 * share page) shows values only: no quote, no way to open one, no regenerate.
 */
export function TableViewer({
  content,
  freshness,
  interactive,
  title,
  version = NO_VERSION,
}: {
  content: TableContent;
  freshness?: TableFreshness;
  /** False narrows the host: the share page shows values only. */
  interactive?: boolean;
  title?: string | null;
  /** Which artifact version this is; the host maps it to its own ids. */
  version?: TableVersionRef;
}) {
  const host = useTableHost();
  const surfaceInteractive = interactive !== false;
  const grounded = useGroundedHostFor(host, freshness, surfaceInteractive);
  const t = host.useTranslate();
  const [sort, setSort] = useState<SortState | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsPanelId = useId();

  // Read after mounting so the server and first client render agree.
  useEffect(() => {
    setHidden(readHiddenColumns());
  }, []);

  const columns = useMemo(() => visibleColumns(content, hidden), [content, hidden]);
  const rows = useMemo(
    () => sortRows(content.rows, sort, content.language),
    [content.rows, content.language, sort],
  );
  const hiddenHere = content.columns.filter((column) => hidden.has(column.id)).length;
  const canRegenerate = surfaceInteractive && host.interactive && host.onRegenerate;

  function toggleColumn(columnId: string) {
    setHidden((current) => {
      const next = new Set(current);
      if (!next.delete(columnId)) next.add(columnId);
      writeHiddenColumns(next);
      return next;
    });
  }

  function showAllColumns() {
    setHidden((current) => {
      const next = new Set(current);
      for (const column of content.columns) next.delete(column.id);
      writeHiddenColumns(next);
      return next;
    });
  }

  function sortHeader(columnId: string, label: string) {
    const direction = sort?.columnId === columnId ? sort.direction : null;
    return (
      <th
        aria-sort={
          direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"
        }
        className={cn(
          HEADER_CELL,
          columnId === SOURCE_COLUMN_ID && "left-0 z-30 min-w-28 max-w-40 sm:min-w-36 sm:max-w-56",
          columnId !== SOURCE_COLUMN_ID && "min-w-40 max-w-80",
        )}
        key={columnId}
        scope="col"
      >
        <button
          className="-mx-1 inline-flex max-w-full items-center gap-1 rounded px-1 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setSort((current) => nextSort(current, columnId))}
          title={t("table.sort.label", { column: label })}
          type="button"
        >
          <span className="min-w-0 break-words">{label}</span>
          <SortIcon direction={direction} />
        </button>
      </th>
    );
  }

  function renderRow(row: TableRow) {
    const state = rowFreshness(row, surfaceInteractive ? freshness : undefined);
    return (
      <tr data-row-id={row.id} data-row-status={row.status} data-stale={state ?? undefined} key={row.id}>
        <th
          className="sticky left-0 z-10 min-w-28 max-w-40 sm:min-w-36 sm:max-w-56 border-b border-r bg-background px-3 py-2 text-left align-top text-sm font-medium break-words"
          scope="row"
        >
          <span>{row.title}</span>
          {state ? (
            <span
              className="mt-1 flex items-center gap-1 text-xs font-normal text-amber-700 dark:text-amber-400"
            >
              <TriangleAlert aria-hidden className="size-3 shrink-0" />
              {t(state === "stale" ? "table.row.stale" : "table.row.sourceDeleted")}
            </span>
          ) : null}
        </th>
        {row.status === "ok" ? (
          columns.map((column) => (
            <TableValueCell
              cell={row.cells[column.id]}
              key={column.id}
              showEvidence={surfaceInteractive}
              t={t}
              version={version}
            />
          ))
        ) : columns.length > 0 ? (
          <td
            className="border-b border-r px-3 py-2 align-top text-sm text-muted-foreground"
            colSpan={columns.length}
          >
            {t(row.status === "failed" ? "table.row.failed" : "table.row.notIndexed")}
          </td>
        ) : null}
      </tr>
    );
  }

  return (
    <GroundedHostProvider host={grounded}>
      <div
        className="flex h-full min-h-0 min-w-0 max-w-full flex-col gap-3 p-3 sm:p-4"
        data-table-viewer
      >
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {t("table.summary", {
              sources: content.rows.length,
              columns: content.columns.length,
            })}
          </p>
          <Button
            aria-controls={columnsPanelId}
            aria-expanded={columnsOpen}
            onClick={() => setColumnsOpen((value) => !value)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Columns3 aria-hidden />
            {t("table.columns.button")}
            {hiddenHere > 0 ? <span aria-hidden>({hiddenHere})</span> : null}
          </Button>
          {canRegenerate ? (
            <Button
              onClick={() => host.onRegenerate?.(version)}
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCw aria-hidden />
              {t("table.toolbar.regenerate")}
            </Button>
          ) : null}
        </div>

        {columnsOpen ? (
          <fieldset
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm"
            id={columnsPanelId}
          >
            <legend className="sr-only">{t("table.columns.label")}</legend>
            {content.columns.map((column) => (
              <label className="inline-flex min-w-0 items-center gap-2" key={column.id}>
                <input
                  checked={!hidden.has(column.id)}
                  className="size-4 shrink-0"
                  onChange={() => toggleColumn(column.id)}
                  type="checkbox"
                />
                <span className="min-w-0 break-words">{column.name}</span>
              </label>
            ))}
            {hiddenHere > 0 ? (
              <Button onClick={showAllColumns} size="xs" type="button" variant="ghost">
                {t("table.columns.showAll")}
              </Button>
            ) : null}
          </fieldset>
        ) : null}

        {surfaceInteractive ? (
          <div className="empty:hidden">
            <StaleBanner version={version} />
          </div>
        ) : null}

        <div
          aria-label={title || t("table.region")}
          className="min-h-0 min-w-0 overflow-auto rounded-lg border"
          role="region"
          tabIndex={0}
        >
          {rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {t("table.empty")}
            </p>
          ) : (
            <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  {sortHeader(SOURCE_COLUMN_ID, t("table.source"))}
                  {columns.map((column) => sortHeader(column.id, column.name))}
                </tr>
              </thead>
              <tbody>{rows.map(renderRow)}</tbody>
            </table>
          )}
        </div>
      </div>
    </GroundedHostProvider>
  );
}
