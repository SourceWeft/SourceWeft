"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { Check, Plus, X } from "lucide-react";
import { AGENT_TASK_LIMITS } from "@sourceweft/contracts/scheduled-tasks";
import { MAX_SELECTED_SKILLS_PER_TURN } from "@sourceweft/contracts/threads";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { contentClient } from "../../../../lib/sdk";

type Choice = { id: string; title: string; meta?: string };

type PanelProps = {
  label: string;
  hint: string;
  addLabel: string;
  searchLabel: string;
  emptyLabel: string;
  moreLabel: string;
  limitLabel: string;
  limit: number;
  selected: Choice[];
  options: Choice[];
  loading: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  /** Present when the list is searched on the server. */
  query?: string;
  onQueryChange?: (value: string) => void;
  onToggle: (id: string) => void;
};

/**
 * A chosen-items row with an inline, searchable list to add more. Inline on
 * purpose: the form already sits in a dialog, and a nested popover would trap
 * focus twice.
 */
function PickerPanel(props: PanelProps) {
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
    <fieldset className="grid gap-1.5">
      <legend className="text-sm font-medium">{props.label}</legend>
      <p className="text-xs text-muted-foreground">{props.hint}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {props.selected.map((item) => (
          <Badge key={item.id} variant="secondary" className="gap-1 pr-1">
            <span className="max-w-48 truncate">{item.title}</span>
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

type PickerProps = {
  workspaceId: string | null;
  /** Fetches only while the form is open. */
  enabled: boolean;
  value: string[];
  onChange: (value: string[]) => void;
};

function toggle(value: string[], id: string) {
  return value.includes(id)
    ? value.filter((item) => item !== id)
    : [...value, id];
}

/** The workspace sources a scheduled run reads from. */
export function SourcePicker({
  workspaceId,
  enabled,
  value,
  onChange,
}: PickerProps) {
  const t = useTranslations("dashboardScheduled");
  const [query, setQuery] = React.useState("");
  const debounced = useDebounced(query.trim(), 300);
  const list = useInfiniteQuery({
    queryKey: ["scheduled", workspaceId, "source-mentions", debounced],
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
  const options = React.useMemo<Choice[]>(
    () =>
      (list.data?.pages ?? []).flatMap((page) =>
        page.items.map((source) => ({
          id: source.id,
          title: source.title || t("form.untitledSource"),
        })),
      ),
    [list.data, t],
  );

  // A saved source that is not on the loaded page is looked up by id, so the
  // chip shows its name; one that no longer exists reads as unavailable.
  const known = new Map(options.map((option) => [option.id, option.title]));
  const missing = value.filter((id) => !known.has(id));
  const lookups = useQueries({
    queries: missing.map((id) => ({
      queryKey: ["scheduled", workspaceId, "source", id],
      queryFn: () => contentClient.getSource(workspaceId!, id),
      enabled: enabled && Boolean(workspaceId),
      retry: false,
      staleTime: 60_000,
    })),
  });
  missing.forEach((id, index) => {
    const result = lookups[index]!;
    if (result.data) {
      known.set(id, result.data.source.title || t("form.untitledSource"));
    } else if (result.isError) {
      known.set(id, t("form.unavailableSource"));
    }
  });
  const selected = value.map((id) => ({
    id,
    title: known.get(id) ?? "…",
  }));

  return (
    <PickerPanel
      label={t("form.sources")}
      hint={t("form.sourcesHint")}
      addLabel={t("form.addSource")}
      searchLabel={t("form.searchSources")}
      emptyLabel={t("form.noSources")}
      moreLabel={t("form.showMore")}
      limitLabel={t("form.sourcesLimit", {
        count: AGENT_TASK_LIMITS.maxSources,
      })}
      limit={AGENT_TASK_LIMITS.maxSources}
      selected={selected}
      options={options}
      loading={list.isLoading}
      hasMore={list.hasNextPage}
      onLoadMore={() => void list.fetchNextPage()}
      query={query}
      onQueryChange={setQuery}
      onToggle={(id) => onChange(toggle(value, id))}
    />
  );
}

/** The skills a scheduled run may use, by the ids the chat sends. */
export function SkillPicker({
  workspaceId,
  enabled,
  value,
  onChange,
}: PickerProps) {
  const t = useTranslations("dashboardScheduled");
  const skills = useQuery({
    queryKey: ["scheduled", workspaceId, "skills"],
    queryFn: async () => {
      const [installed, catalog] = await Promise.all([
        contentClient.listWorkspaceSkills(workspaceId!),
        contentClient.listSkillsCatalog(workspaceId!),
      ]);
      const choices: Choice[] = [];
      for (const skill of catalog.items) {
        if (
          skill.sourceType === "builtin" &&
          !skill.installable &&
          skill.selectionId
        ) {
          choices.push({
            id: skill.selectionId,
            title: skill.displayName || skill.name,
          });
        }
      }
      for (const skill of installed.items) {
        if (skill.enabled) {
          choices.push({
            id: skill.selectionId,
            title: skill.displayName || skill.name,
          });
        }
      }
      return choices;
    },
    enabled: enabled && Boolean(workspaceId),
    staleTime: 30_000,
  });
  const options = skills.data ?? [];
  const known = new Map(options.map((option) => [option.id, option.title]));
  const selected = value.map((id) => ({
    id,
    title:
      known.get(id) ?? (skills.isLoading ? "…" : t("form.unavailableSkill")),
  }));

  return (
    <PickerPanel
      label={t("form.skills")}
      hint={t("form.skillsHint")}
      addLabel={t("form.addSkill")}
      searchLabel={t("form.searchSkills")}
      emptyLabel={t("form.noSkills")}
      moreLabel={t("form.showMore")}
      limitLabel={t("form.skillsLimit", {
        count: MAX_SELECTED_SKILLS_PER_TURN,
      })}
      limit={MAX_SELECTED_SKILLS_PER_TURN}
      selected={selected}
      options={options}
      loading={skills.isLoading}
      onToggle={(id) => onChange(toggle(value, id))}
    />
  );
}
