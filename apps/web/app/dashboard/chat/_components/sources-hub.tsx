"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  Link2,
  Search,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Checkbox } from "@sourceweft/ui-web/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@sourceweft/ui-web/components/ui/collapsible";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { cn } from "@sourceweft/ui-web/lib/utils";
import {
  citations,
  connectors,
  librarySources,
  type SourceItem,
} from "./mock-data";

const tabs = ["Library", "Citations", "Connectors"] as const;

const tabCounts: Partial<Record<(typeof tabs)[number], number>> = {
  Citations: citations.length,
  Connectors: connectors.length,
};

type CheckedState = boolean | "indeterminate";

function TypeBadge({ label }: { label: string }) {
  return (
    <span className="rounded-md border border-input bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
      {label}
    </span>
  );
}

function StatusDot({ status }: { status: SourceItem["status"] }) {
  return (
    <span
      className={cn(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        status === "Indexed"
          ? "bg-emerald-500"
          : status === "Syncing"
            ? "bg-amber-500"
            : "bg-red-400",
      )}
    />
  );
}

// ---- Individual file row ----

function SourceRow({
  source,
  selected,
  onToggle,
}: {
  source: SourceItem;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors",
        selected ? "bg-primary/5" : "hover:bg-accent/60",
      )}
    >
      <Checkbox
        checked={selected}
        className="mt-0.5"
        onCheckedChange={() => onToggle(source.id)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <FileText className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium text-foreground">
            {source.title}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <StatusDot status={source.status} />
          <span className="truncate text-[10px] text-muted-foreground">
            {source.meta}
          </span>
          <TypeBadge label={source.type} />
        </div>
      </div>
    </label>
  );
}

// ---- Folder group ----

function FolderGroup({
  name,
  sources,
  selectedIds,
  onToggle,
}: {
  name: string;
  sources: SourceItem[];
  selectedIds: string[];
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);

  const selectedCount = sources.filter((s) =>
    selectedIds.includes(s.id),
  ).length;
  const folderChecked: CheckedState =
    selectedCount === 0
      ? false
      : selectedCount === sources.length
        ? true
        : "indeterminate";

  function handleFolderCheck(checked: boolean) {
    if (checked) {
      sources.forEach((s) => {
        if (!selectedIds.includes(s.id)) onToggle(s.id);
      });
    } else {
      sources.forEach((s) => {
        if (selectedIds.includes(s.id)) onToggle(s.id);
      });
    }
  }

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <div className="flex items-center gap-1.5 py-1">
        <Checkbox
          checked={folderChecked}
          onCheckedChange={(val) => handleFolderCheck(val as boolean)}
        />
        <CollapsibleTrigger asChild>
          <button
            className="flex flex-1 items-center gap-1.5 text-left"
            type="button"
          >
            {open ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs font-medium text-foreground">{name}</span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {sources.length}
            </span>
          </button>
        </CollapsibleTrigger>
      </div>

      <CollapsibleContent>
        <div className="ml-5 space-y-0.5 border-l border-border pl-2.5 pb-1">
          {sources.map((source) => (
            <SourceRow
              key={source.id}
              onToggle={onToggle}
              selected={selectedIds.includes(source.id)}
              source={source}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---- Library tab ----

function LibraryTab({
  searchQuery,
  selectedIds,
  onToggle,
}: {
  searchQuery: string;
  selectedIds: string[];
  onToggle: (id: string) => void;
}) {
  const q = searchQuery.toLowerCase();

  const filtered = useMemo(
    () =>
      q
        ? librarySources.filter((s) => s.title.toLowerCase().includes(q))
        : librarySources,
    [q],
  );

  const folders = useMemo(() => {
    const map = new Map<string | undefined, SourceItem[]>();
    for (const s of filtered) {
      const key = s.folder;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return map;
  }, [filtered]);

  const folderNames = useMemo(
    () =>
      Array.from(folders.keys()).filter((k): k is string => k !== undefined),
    [folders],
  );
  const rootItems = folders.get(undefined) ?? [];

  if (filtered.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        No sources match &quot;{searchQuery}&quot;
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {folderNames.map((name) => (
        <FolderGroup
          key={name}
          name={name}
          onToggle={onToggle}
          selectedIds={selectedIds}
          sources={folders.get(name)!}
        />
      ))}

      {rootItems.length > 0 && (
        <div className="space-y-0.5">
          {rootItems.map((source) => (
            <SourceRow
              key={source.id}
              onToggle={onToggle}
              selected={selectedIds.includes(source.id)}
              source={source}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- SourcesHub ----

export function SourcesHub({
  mode,
  selectedIds,
  onSelectionChange,
}: {
  mode: "thread" | "new";
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
}) {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>(
    mode === "thread" ? "Citations" : "Library",
  );
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    setActiveTab(mode === "thread" ? "Citations" : "Library");
  }, [mode]);

  function handleToggle(id: string) {
    if (selectedIds.includes(id)) {
      onSelectionChange(selectedIds.filter((x) => x !== id));
    } else {
      onSelectionChange([...selectedIds, id]);
    }
  }

  return (
    <aside className="flex h-full w-[410px] shrink-0 flex-col border-l bg-background">
      {/* Header */}
      <div className="shrink-0 border-b px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Sources</h2>
        </div>

        {/* Search */}
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-xs"
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search sources..."
            value={searchQuery}
          />
          {searchQuery && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setSearchQuery("")}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="mt-2 flex flex-wrap gap-1 border-t pt-2">
          {tabs.map((tab) => (
            <button
              className={cn(
                "rounded-lg px-2.5 py-1 text-[11px] transition-colors",
                activeTab === tab
                  ? "bg-secondary text-foreground shadow-xs ring-1 ring-border"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              key={tab}
              onClick={() => setActiveTab(tab)}
              type="button"
            >
              <span>{tab}</span>
              {tabCounts[tab] !== undefined ? (
                <span className="ml-1.5 text-[10px] text-current/70">
                  {tabCounts[tab]}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {/* Library */}
        {activeTab === "Library" && (
          <section className="space-y-1">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-medium text-foreground">Library</h3>
                <span className="text-[10px] text-muted-foreground">
                  {librarySources.length} sources
                </span>
                {selectedIds.length > 0 ? (
                  <span className="text-[10px] text-primary">
                    {selectedIds.length} selected
                  </span>
                ) : null}
              </div>
              <div className="flex min-h-8 w-[108px] items-center justify-end gap-1.5">
                <Button
                  size="icon-xs"
                  title="Create folder"
                  type="button"
                  variant="ghost"
                >
                  <FolderPlus className="size-3.5" />
                  <span className="sr-only">Create folder</span>
                </Button>
                <Button size="xs" type="button" variant="outline">
                  <Upload className="size-3.5" />
                  Add source
                </Button>
              </div>
            </div>
            <LibraryTab
              onToggle={handleToggle}
              searchQuery={searchQuery}
              selectedIds={selectedIds}
            />
          </section>
        )}

        {/* Citations */}
        {activeTab === "Citations" && (
          <section className="space-y-1">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-medium text-foreground">
                  Citations
                </h3>
                <span className="text-[10px] text-muted-foreground">
                  {citations.length} citations
                </span>
              </div>
              <div className="flex min-h-8 w-[108px] items-center justify-end gap-1.5" />
            </div>
            {mode === "new" ? (
              <div className="rounded-2xl border border-dashed bg-muted/20 px-4 py-6 text-sm text-muted-foreground">
                Citations appear after the assistant grounds an answer in your
                sources.
              </div>
            ) : (
              <div className="space-y-1.5">
                {citations.map((citation, index) => (
                  <article
                    className="rounded-lg border bg-background p-2.5 shadow-xs"
                    key={citation.id}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                          {citation.messageLabel}
                        </div>
                        <h4 className="mt-0.5 truncate text-sm font-medium text-foreground">
                          [{index + 1}] {citation.sourceTitle}
                        </h4>
                      </div>
                      <Button size="xs" type="button" variant="outline">
                        <FileText className="size-3.5" />
                        Open
                      </Button>
                    </div>
                    <div className="mt-2 rounded-md border border-input bg-muted/20 px-2 py-2 text-sm leading-6 text-foreground">
                      {citation.excerpt}
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="rounded-full border border-input bg-background px-2 py-0.5">
                        grounded excerpt
                      </span>
                      <span>Jump back to message</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Connectors */}
        {activeTab === "Connectors" && (
          <section className="space-y-1">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-medium text-foreground">
                  Connectors
                </h3>
                <span className="text-[10px] text-muted-foreground">
                  {connectors.length} connectors
                </span>
              </div>
              <div className="flex min-h-8 w-[108px] items-center justify-end gap-1.5">
                <Button size="xs" type="button" variant="outline">
                  <Link2 className="size-3.5" />
                  Connect
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              {connectors.map((connector) => (
                <article
                  className="rounded-lg border bg-background p-2.5 shadow-xs"
                  key={connector.id}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">
                      {connector.name}
                    </p>
                    <span className="text-[11px] text-muted-foreground">
                      {connector.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {connector.meta}
                  </p>
                  {mode === "new" ? (
                    <div className="mt-3">
                      <Button size="xs" type="button" variant="outline">
                        <Upload className="size-3.5" />
                        Pull sources
                      </Button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}
