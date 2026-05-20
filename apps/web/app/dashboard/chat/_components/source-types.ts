export type SourceItem = {
  id: string;
  title: string;
  sourceType:
    | "manual_upload"
    | "file_upload"
    | "web_url"
    | "youtube"
    | "note"
    | "artifact"
    | "connector"
    | "directory";
  parentSourceId: string | null;
  type: "DIR" | "PDF" | "DOC" | "WEB" | "NOTE" | "TEXT" | "CSV" | "JSON" | "IMG" | "AUDIO";
  status: "Indexed" | "Syncing" | "Failed" | "Needs review";
  meta: string;
  contentText: string;
  connectorId?: string | null;
  externalUri?: string | null;
  metadata?: Record<string, unknown>;
  storageKey?: string | null;
  updatedAt?: string;
};

export function expandSelectedSources(
  sources: SourceItem[],
  selectedIds: string[],
) {
  const selectedSet = new Set(selectedIds);
  const sourcesByParent = new Map<string | null, SourceItem[]>();

  for (const source of sources) {
    const items = sourcesByParent.get(source.parentSourceId) ?? [];
    items.push(source);
    sourcesByParent.set(source.parentSourceId, items);
  }

  const expanded: SourceItem[] = [];
  const seen = new Set<string>();

  function isSelectableSource(source: SourceItem) {
    return source.status !== "Failed" && source.status !== "Syncing";
  }

  function addSource(source: SourceItem) {
    if (!isSelectableSource(source) || seen.has(source.id)) {
      return;
    }
    seen.add(source.id);
    expanded.push(source);
  }

  function addSubtree(source: SourceItem) {
    addSource(source);
    for (const child of sourcesByParent.get(source.id) ?? []) {
      addSubtree(child);
    }
  }

  for (const source of sources) {
    if (!isSelectableSource(source)) {
      continue;
    }
    if (!selectedSet.has(source.id)) {
      continue;
    }
    addSubtree(source);
  }

  return expanded;
}
