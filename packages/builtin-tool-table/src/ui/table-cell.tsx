"use client";

import { useId, useState } from "react";
import { CircleHelp } from "lucide-react";
import type { TableCell as TableCellData } from "@sourceweft/contracts/table";
import { EvidencePopover } from "@sourceweft/grounded-generation/ui";
import { cn } from "@sourceweft/ui-web/lib/utils";
import type { TableTranslate, TableVersionRef } from "./table-host";

const CELL_CLASS =
  "min-w-40 max-w-80 border-b border-r px-3 py-2 align-top break-words whitespace-pre-wrap";

/**
 * One answer cell.
 *
 * - `found`: the value, as the source wrote it. With evidence on show, the
 *   value is a button (so it takes focus and opens with Enter or Space) that
 *   reveals the quote under it.
 * - `not_found`: the source does not mention it; shown weakened.
 * - `unverified`: the model proposed something the source text could not
 *   confirm. The proposal is not stored and is never shown, only that it
 *   could not be verified.
 */
export function TableValueCell({
  cell,
  version,
  showEvidence,
  t,
}: {
  cell: TableCellData | undefined;
  version: TableVersionRef;
  /** False on the share surface: no quote, no way to open one. */
  showEvidence: boolean;
  t: TableTranslate;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();

  if (!cell) {
    return (
      <td className={cn(CELL_CLASS, "text-muted-foreground")}>
        <span aria-label={t("table.cell.missing")}>—</span>
      </td>
    );
  }

  if (cell.status === "not_found") {
    return (
      <td className={cn(CELL_CLASS, "text-muted-foreground italic")} data-cell-status="not_found">
        {t("table.cell.notFound")}
      </td>
    );
  }

  if (cell.status === "unverified") {
    return (
      <td className={cn(CELL_CLASS, "text-muted-foreground")} data-cell-status="unverified">
        <span className="inline-flex items-start gap-1.5" title={t("table.cell.unverifiedHint")}>
          <CircleHelp aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{t("table.cell.unverified")}</span>
          <span className="sr-only">{t("table.cell.unverifiedHint")}</span>
        </span>
      </td>
    );
  }

  return (
    <td className={CELL_CLASS} data-cell-status="found">
      {showEvidence ? (
        <div className="space-y-2">
          <button
            aria-controls={open ? regionId : undefined}
            aria-expanded={open}
            className="-mx-1 rounded px-1 text-left underline decoration-dotted underline-offset-4 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setOpen((value) => !value)}
            type="button"
          >
            {cell.value}
          </button>
          {open ? (
            <div id={regionId}>
              <EvidencePopover
                artifactId={version.artifactId}
                defaultOpen
                evidence={cell.evidence}
                workspaceId={version.workspaceId}
              />
            </div>
          ) : null}
        </div>
      ) : (
        cell.value
      )}
    </td>
  );
}
