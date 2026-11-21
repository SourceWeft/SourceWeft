"use client";

import * as React from "react";
import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { Check, Plus, X } from "lucide-react";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { contentClient } from "../../../lib/sdk";

export type ResourceChoice = { id: string; title: string; meta?: string };

export type ResourcePickerPanelProps = {
  label: string;
  hint?: string;
  addLabel: string;
  searchLabel: string;
  emptyLabel: string;
  moreLabel: string;
  limitLabel: string;
  limit: number;
  selected: ResourceChoice[];
  options: ResourceChoice[];
  loading: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  /** Present when the list is searched on the server. */
  query?: string;
  onQueryChange?: (value: string) => void;
  onToggle: (id: string) => void;
  /** Removing chips and adding are both off. */
  disabled?: boolean;
};

/**
 * A chosen-items row with an inline, searchable list to add more. Inline on
 * purpose: pickers sit in dialogs, and a nested popover would trap focus twice.
 */
export function ResourcePickerPanel(props: ResourcePickerPanelProps) {
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const searched = props.onQueryChange !== undefined;
  const text = searched ? (props.query ?? "") : filter;
  const selectedIds = new Set(props.selected.map((item) => item.id));
  const visible = searched
    ? props.options
    : props.options.filter((option) =>
        option.title.toLowerCase().includes(filter.trim().toLowerCase()),
      );
  const full = props.selected.length >= props.limit;

  return (
    <fieldset className="grid min-w-0 gap-1.5" disabled={props.disabled}>
      <legend className="text-sm font-medium">{props.label}</legend>
      {props.hint ? (
        <p className="text-xs text-muted-foreground">{props.hint}</p>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {props.selected.map((item) => (
          <Badge
            key={item.id}
            variant="secondary"
            className="max-w-full gap-1 pr-1"
          >
            <span className="max-w-48 truncate" title={item.title}>
              {item.title}
            </span>
            <button
              type="button"
              className="rounded-sm p-0.5 hover:bg-muted"
              aria-label={`${props.label}: ${item.title} ×`}
              onClick={() => props.onToggle(item.id)}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Plus className="size-3.5" />
          {props.addLabel}
        </Button>
      </div>
      {open ? (
        <div className="grid gap-1.5 rounded-lg border border-border p-2">
          <Input
            aria-label={props.searchLabel}
            placeholder={props.searchLabel}
            value={text}
            onChange={(event) =>
              searched
                ? props.onQueryChange!(event.target.value)
                : setFilter(event.target.value)
            }
          />
          {full ? (
            <p className="text-xs text-muted-foreground">{props.limitLabel}</p>
          ) : null}
          <ul className="max-h-48 overflow-y-auto">
            {visible.map((option) => {
              const picked = selectedIds.has(option.id);
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={picked}
                    disabled={!picked && full}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
                    onClick={() => props.onToggle(option.id)}
                  >
                    <span className="flex size-4 items-center justify-center">
                      {picked ? <Check className="size-4" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {option.title}
                    </span>
                    {option.meta ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {option.meta}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {!props.loading && visible.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {props.emptyLabel}
            </p>
          ) : null}
          {props.hasMore ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={props.onLoadMore}
            >
              {props.moreLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

function useDebounced(value: string, ms: number) {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function toggleChoice(value: readonly string[], id: string) {
  return value.includes(id)
    ? value.filter((item) => item !== id)
    : [...value, id];
}

export type WorkspaceSourcePickerLabels = Omit<
  ResourcePickerPanelProps,
  | "limit"
  | "selected"
  | "options"
  | "loading"
  | "hasMore"
  | "onLoadMore"
  | "query"
  | "onQueryChange"
  | "onToggle"
  | "disabled"
> & {
  /** Shown for a source without a title. */
  untitled: string;
  /** Shown for a chosen source that no longer exists. */
  unavailable: string;
};

export type WorkspaceSourcePickerProps = {
  workspaceId: string | null;
  /** Fetches only while the surrounding form is open. */
  enabled: boolean;
  value: readonly string[];
  onChange: (value: string[]) => void;
  limit: number;
  labels: WorkspaceSourcePickerLabels;
  /** Titles the caller already has, so those chips need no lookup. */
  knownTitles?: ReadonlyMap<string, string>;
  disabled?: boolean;
};

/**
 * Picks workspace sources (documents, not folders) by searching their titles.
 * A chosen source that is not on a loaded page and not in `knownTitles` is
 * looked up by id, so its chip shows its name; one that no longer exists
 * reads as unavailable.
 */
export function WorkspaceSourcePicker({
  workspaceId,
  enabled,
  value,
  onChange,
  limit,
  labels,
  knownTitles,
  disabled,
}: WorkspaceSourcePickerProps) {
  const [query, setQuery] = React.useState("");
  const debounced = useDebounced(query.trim(), 300);
  const { untitled, unavailable, ...panelLabels } = labels;
  const list = useInfiniteQuery({
    queryKey: ["workspace-source-mentions", workspaceId, debounced],
    queryFn: ({ pageParam }) =>
      contentClient.listSourceMentions(workspaceId!, {
        query: debounced || undefined,
        limit: 20,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: enabled && Boolean(workspaceId),
    staleTime: 30_000,
  });
  const options = React.useMemo<ResourceChoice[]>(
    () =>
      (list.data?.pages ?? []).flatMap((page) =>
        page.items.map((source) => ({
          id: source.id,
          title: source.title || untitled,
        })),
      ),
    [list.data, untitled],
  );

  const known = new Map(knownTitles);
  for (const option of options) known.set(option.id, option.title);
  const missing = value.filter((id) => !known.has(id));
  const lookups = useQueries({
    queries: missing.map((id) => ({
      queryKey: ["workspace-source", workspaceId, id],
      queryFn: () => contentClient.getSource(workspaceId!, id),
      enabled: enabled && Boolean(workspaceId),
      retry: false,
      staleTime: 60_000,
    })),
  });
  missing.forEach((id, index) => {
    const result = lookups[index]!;
    if (result.data) {
      known.set(id, result.data.source.title || untitled);
    } else if (result.isError) {
      known.set(id, unavailable);
    }
  });
  const selected = value.map((id) => ({ id, title: known.get(id) ?? "…" }));

  return (
    <ResourcePickerPanel
      {...panelLabels}
      limit={limit}
      selected={selected}
      options={options}
      loading={list.isLoading}
      hasMore={list.hasNextPage}
      onLoadMore={() => void list.fetchNextPage()}
      query={query}
      onQueryChange={setQuery}
      onToggle={(id) => onChange(toggleChoice(value, id))}
      disabled={disabled}
    />
  );
}
