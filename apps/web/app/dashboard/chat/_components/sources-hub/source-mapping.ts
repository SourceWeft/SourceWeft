import { contentClient } from "../../../../../lib/sdk";
import type { SourceItem } from "../source-types";

export type SourceApiRecord = Awaited<
  ReturnType<typeof contentClient.listSources>
>["items"][number];

function apiStatusToSourceStatus(status: string): SourceItem["status"] {
  if (status === "indexed") return "Indexed";
  if (status === "processing" || status === "queued") return "Syncing";
  if (status === "failed") return "Failed";
  return "Needs review";
}

function apiTypeToSourceType(
  sourceType: string,
  mimeType: string | null,
): SourceItem["type"] {
  if (sourceType === "directory") return "DIR";
  if (sourceType === "web_url" || sourceType === "youtube") return "WEB";
  if (sourceType === "note") return "NOTE";
  if (mimeType?.includes("pdf")) return "PDF";
  if (mimeType?.startsWith("image/")) return "IMG";
  if (mimeType?.startsWith("audio/") || mimeType?.startsWith("video/")) {
    return "AUDIO";
  }
  if (mimeType?.includes("csv")) return "CSV";
  if (mimeType?.includes("json")) return "JSON";
  if (mimeType?.startsWith("text/")) return "TEXT";
  return "DOC";
}

export function mapSourcesToUi(items: SourceApiRecord[]): SourceItem[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title || "Untitled",
    sourceType: item.sourceType,
    parentSourceId: item.parentSourceId,
    type: apiTypeToSourceType(item.sourceType, item.mimeType),
    status: apiStatusToSourceStatus(item.status),
    meta:
      item.sourceType === "directory"
        ? "Folder"
        : item.status === "failed"
          ? "Processing failed"
          : item.status === "queued" || item.status === "processing"
            ? "Sync in progress"
            : new Date(item.updatedAt).toLocaleString(),
    contentText: item.contentText,
    connectorId: item.connectorId,
    externalUri: item.externalUri,
    metadata: item.metadata,
    storageKey: item.storageKey,
    updatedAt: item.updatedAt,
  }));
}
