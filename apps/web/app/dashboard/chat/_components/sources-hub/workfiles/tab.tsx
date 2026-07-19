import { FileText, Loader2, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@sourceweft/ui-web/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import { HubEmptyState } from "../components/hub-empty-state";
import { basename, formatBytes } from "../lib/format";
import { memoComponent } from "../memo-component";
import { TypeBadge } from "../type-badge";
import {
  workfileMatchesQuery,
  workfilePurposeLabel,
  type WorkfileListItem,
} from "./use-workfiles";

export const WorkfilesTab = memoComponent(function WorkfilesTab({
  files,
  isLoading,
  loadingError,
  onDelete,
  onOpen,
  onRefresh,
  rowBusyByPath,
  searchQuery,
}: {
  files: WorkfileListItem[];
  isLoading: boolean;
  loadingError: string | null;
  onDelete: (file: WorkfileListItem) => void;
  onOpen: (file: WorkfileListItem) => void;
  onRefresh: () => void;
  rowBusyByPath: Record<string, boolean>;
  searchQuery: string;
}) {
  const q = searchQuery.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? files.filter((file) => workfileMatchesQuery(file, q)) : files),
    [files, q],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
        <Loader2 className="mr-2 size-3.5 animate-spin" />
        Loading workfiles...
      </div>
    );
  }

  if (loadingError) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
        <p className="text-xs text-destructive">{loadingError}</p>
        <Button
          className="mt-2"
          onClick={onRefresh}
          size="xs"
          type="button"
          variant="outline"
        >
          <RotateCcw className="size-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <HubEmptyState
        description={
          searchQuery
            ? "Try a different path, purpose, or file type."
            : "Assistant-created plans, notes, extraction tables, calculations, drafts, and candidate outputs from complex work will appear here."
        }
        icon={FileText}
        title={
          searchQuery
            ? `No workfiles match "${searchQuery}"`
            : "Workfiles will appear here."
        }
      />
    );
  }

  return (
    <div className="space-y-1">
      {filtered.map((file) => {
        const busy = Boolean(rowBusyByPath[file.path]);
        return (
          <article
            className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/60"
            key={file.id}
          >
            <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <button
                className="block w-full cursor-pointer truncate text-left text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                disabled={busy}
                onClick={() => onOpen(file)}
                title={file.path}
                type="button"
              >
                {basename(file.path)}
              </button>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="truncate">{file.path}</span>
                <span>{formatBytes(file.sizeBytes)}</span>
                <span>{new Date(file.updatedAt).toLocaleString()}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {file.purpose ? (
                  <TypeBadge label={workfilePurposeLabel(file.purpose)} />
                ) : null}
                <TypeBadge label={file.mimeType} />
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  className="opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  disabled={busy}
                  onClick={(event) => event.stopPropagation()}
                  size="icon-xs"
                  title="Workfile actions"
                  type="button"
                  variant="ghost"
                >
                  {busy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <MoreHorizontal className="size-3.5" />
                  )}
                  <span className="sr-only">Workfile actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem
                  className="whitespace-nowrap"
                  onClick={() => onOpen(file)}
                >
                  <FileText className="size-3.5" />
                  Preview
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="whitespace-nowrap"
                  onClick={() => onDelete(file)}
                  variant="destructive"
                >
                  <Trash2 className="size-3.5" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </article>
        );
      })}
    </div>
  );
});
