import type { ReactNode } from "react";
import { FileText, Folder, Globe, Music2 } from "lucide-react";
import { GlobalIcon } from "@sourceweft/ui-web/components/ui/global-icon";
import { cn } from "@sourceweft/ui-web/lib/utils";
import type { SourceItem } from "../source-types";

export function toAttachmentData(source: SourceItem) {
  return {
    id: source.id,
    mediaType: source.type,
    sourceId: source.id,
    subtitle: source.meta,
    title: source.title,
    type: "source-document" as const,
  };
}

function uniqueSourceIds(sourceIds: string[]) {
  return [...new Set(sourceIds.filter((sourceId) => sourceId.length > 0))];
}

function getRecordValue(
  record: Record<string, unknown> | undefined,
  key: string,
) {
  return record && typeof record[key] === "string" ? record[key] : null;
}

function sourceConnectorIconName(source: SourceItem) {
  if (source.sourceType !== "connector") return null;
  return (
    getRecordValue(source.metadata, "connectorType") ??
    getRecordValue(source.metadata, "provider")
  );
}

export function mergeSourceIds(...sourceIdGroups: (string[] | undefined)[]) {
  return uniqueSourceIds(
    sourceIdGroups.flatMap((sourceIds) => sourceIds ?? []),
  );
}

export function SourceIcon({
  className = "size-3.5",
  source,
}: {
  className?: string;
  source: SourceItem;
}) {
  const connectorIconName = sourceConnectorIconName(source);
  if (connectorIconName) {
    return (
      <GlobalIcon
        className={cn(className, "shrink-0")}
        fallbackIconName="tool"
        iconName={connectorIconName}
        iconTone="brand"
      />
    );
  }
  if (source.sourceType === "directory" || source.type === "DIR") {
    return <Folder className={cn(className, "text-primary")} />;
  }
  if (source.type === "AUDIO") {
    return <Music2 className={cn(className, "text-muted-foreground")} />;
  }
  if (source.type === "WEB") {
    return <Globe className={cn(className, "text-muted-foreground")} />;
  }
  return <FileText className={cn(className, "text-muted-foreground")} />;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSourceMentionLabel(title: string) {
  return `@${title}`;
}

function getMentionMatchLabels(source: SourceItem) {
  const labels = [getSourceMentionLabel(source.title)]
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
  return [...new Set(labels)];
}

function inferMentionSourceType(label: string): SourceItem["type"] {
  const normalized = label.toLowerCase();
  if (normalized.endsWith(".pdf")) return "PDF";
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(normalized)) return "IMG";
  if (/\.(mp3|mp4|mpeg|m4a|wav|webm|ogg|flac)$/.test(normalized)) {
    return "AUDIO";
  }
  if (normalized.endsWith(".csv")) return "CSV";
  if (normalized.endsWith(".json")) return "JSON";
  if (/\.(txt|md|markdown)$/.test(normalized)) return "TEXT";
  return "DOC";
}

function createFallbackMentionSource(input: {
  label: string;
  sourceId: string;
}): SourceItem {
  const title = input.label.startsWith("@")
    ? input.label.slice(1)
    : input.label;

  return {
    id: input.sourceId,
    title,
    sourceType: "file_upload",
    parentSourceId: null,
    type: inferMentionSourceType(title),
    status: "Indexed",
    meta: "Mentioned source",
    contentText: "",
    storageKey: null,
  };
}

function SourceMentionLink({
  label,
  onSourcePreview,
  source,
}: {
  label: string;
  onSourcePreview?: (source: SourceItem) => void;
  source: SourceItem;
}) {
  return (
    <button
      className="inline cursor-pointer bg-transparent p-0 align-baseline font-medium text-primary underline decoration-primary/35 underline-offset-2 transition-colors hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onSourcePreview?.(source)}
      title={`Open preview: ${source.title}`}
      type="button"
    >
      {label}
    </button>
  );
}

export function UserMessageText({
  children,
  onSourcePreview,
  sources,
  sourceIds = [],
}: {
  children: string;
  onSourcePreview?: (source: SourceItem) => void;
  sources: SourceItem[];
  sourceIds?: string[];
}) {
  const mentionSources = sources.filter(
    (source) => source.sourceType !== "directory" && source.type !== "DIR",
  );

  if (mentionSources.length === 0 && sourceIds.length === 0) {
    return <>{children}</>;
  }

  const labelToSource = new Map<string, SourceItem>();
  const sourceById = new Map(
    mentionSources.map((source) => [source.id, source]),
  );
  const sourceLabelsById = new Map<string, string>();
  for (const source of mentionSources) {
    for (const label of getMentionMatchLabels(source)) {
      labelToSource.set(label, source);
      sourceLabelsById.set(source.id, label);
    }
  }

  for (const sourceId of sourceIds) {
    const source = sourceById.get(sourceId);
    const label = source ? sourceLabelsById.get(source.id) : null;
    if (!source || !label || labelToSource.has(label)) {
      continue;
    }
    labelToSource.set(label, source);
  }

  let fallbackIndex = 0;
  for (const token of children.match(/@\S+/g) ?? []) {
    if (labelToSource.has(token)) {
      continue;
    }
    const sourceId = sourceIds[fallbackIndex];
    fallbackIndex += 1;
    if (!sourceId) {
      continue;
    }
    labelToSource.set(token, createFallbackMentionSource({ label: token, sourceId }));
  }

  const labels = [...labelToSource.keys()].sort(
    (left, right) => right.length - left.length,
  );

  if (labels.length === 0) {
    return <>{children}</>;
  }

  const pattern = new RegExp(labels.map(escapeRegExp).join("|"), "g");
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(children)) !== null) {
    const label = match[0];
    const source = labelToSource.get(label);

    if (!source) {
      continue;
    }

    if (match.index > lastIndex) {
      parts.push(children.slice(lastIndex, match.index));
    }

    parts.push(
      <SourceMentionLink
        key={`${source.id}-${match.index}`}
        label={label}
        onSourcePreview={onSourcePreview}
        source={source}
      />,
    );
    lastIndex = match.index + label.length;
  }

  if (lastIndex < children.length) {
    parts.push(children.slice(lastIndex));
  }

  return parts.length > 0 ? <>{parts}</> : <>{children}</>;
}

