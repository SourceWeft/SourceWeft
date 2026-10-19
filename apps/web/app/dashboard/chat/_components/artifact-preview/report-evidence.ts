import {
  fileLocatorSchema,
  fileReferenceSchema,
  type FileReference,
} from "@sourceweft/contracts";
import type { CitationRecord } from "../chat-canvas/types";

// Member-only private source file of a published report
// (packages/builtin-skill-report). `sources[].provenance` is private and never
// reaches public exports; it carries the identity each citation came from.
// Four shapes, discriminated by `kind`; an object without `kind` is a legacy
// row (free-form strings) that cannot be resolved into a preview.
export const REPORT_SOURCE_FILE_NAME = "report.source.json";

export type ReportEvidenceProvenance =
  | {
      kind: "chunk";
      sourceId: string;
      documentId: string;
      chunkId: string;
      chunkNo?: number;
    }
  | {
      kind: "file";
      reference: FileReference;
    }
  | { kind: "external"; url: string }
  | { kind: "legacy" }
  | { kind: "missing" };

export type ReportEvidenceSource = {
  id: string;
  title: string;
  locator: string | null;
  url: string | null;
  provenance: ReportEvidenceProvenance;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// Only `text/markdown` changes FileCitationPreview's behaviour (it skips the
// line jump for markdown); the rest just labels the viewer. Unknown extensions
// fall back to a generic binary type so the preview still downloads and hashes.
const MIME_BY_EXTENSION: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function guessMimeType(relativePath: string): string {
  const name = relativePath.split("/").pop() ?? relativePath;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/**
 * Build the `FileReference` that FileCitationPreview expects from a `file`
 * provenance row. There is no SDK call that returns a `FileRef` by fileId, so
 * the host-owned fields are synthesized here:
 *   - `name` is the last path segment, `mimeType` is guessed from the extension
 *     (the file is served by path, so neither is needed for the fetch);
 *   - `sizeBytes` 0, `origin` "unknown" and all-false `capabilities` are
 *     placeholders: FileCitationPreview only reads `origin` for a label and
 *     never consults capabilities or size.
 * The preview still works because it downloads the file by `backendKind` +
 * `relativePath` and re-hashes the bytes against `revision`, so the identity
 * fields that matter (`workspaceId`, `threadId`, `fileId`, `relativePath`,
 * `revision`, `locator`) are the ones the footnote actually carries.
 */
function synthesizeFileReference(
  value: Record<string, unknown>,
): FileReference | null {
  const relativePath = nonEmptyString(value.relativePath);
  const locator = fileLocatorSchema.safeParse(value.locator);
  if (!relativePath || !locator.success) return null;
  const candidate = {
    presentation: locator.data.kind === "image" ? "visual" : "text",
    workspaceId: value.workspaceId,
    threadId: value.threadId,
    file: {
      scopeKind: "files",
      backendKind: value.backendKind,
      fileId: value.fileId,
      relativePath,
      name: relativePath.split("/").pop() ?? relativePath,
      mimeType: guessMimeType(relativePath),
      sizeBytes: 0,
      revision: value.revision,
      origin: "unknown",
      capabilities: {
        readText: false,
        readDocument: false,
        viewImage: false,
        searchText: false,
        write: false,
      },
    },
    locator: locator.data,
  };
  const parsed = fileReferenceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function parseProvenance(value: unknown): ReportEvidenceProvenance {
  if (!isRecord(value)) return { kind: "missing" };
  if (!("kind" in value)) return { kind: "legacy" };
  switch (value.kind) {
    case "chunk": {
      const sourceId = nonEmptyString(value.sourceId);
      const documentId = nonEmptyString(value.documentId);
      const chunkId = nonEmptyString(value.chunkId);
      if (!sourceId || !documentId || !chunkId) return { kind: "missing" };
      const chunkNo =
        typeof value.chunkNo === "number" &&
        Number.isInteger(value.chunkNo) &&
        value.chunkNo >= 0
          ? value.chunkNo
          : undefined;
      return { kind: "chunk", sourceId, documentId, chunkId, chunkNo };
    }
    case "file": {
      const reference = synthesizeFileReference(value);
      return reference ? { kind: "file", reference } : { kind: "missing" };
    }
    case "external": {
      const url = nonEmptyString(value.url);
      return url && isSafeHttpUrl(url)
        ? { kind: "external", url }
        : { kind: "missing" };
    }
    default:
      return { kind: "missing" };
  }
}

/**
 * Defensive reader for `report.source.json`. Returns null when the document is
 * not a report source (so the panel renders nothing) and drops individual rows
 * that lack an id or title instead of failing the whole list.
 */
export function parseReportEvidenceSources(
  value: unknown,
): ReportEvidenceSource[] | null {
  if (!isRecord(value) || !Array.isArray(value.sources)) return null;
  const sources: ReportEvidenceSource[] = [];
  for (const entry of value.sources) {
    if (!isRecord(entry)) continue;
    const id = nonEmptyString(entry.id);
    const display = isRecord(entry.display) ? entry.display : null;
    const title = display ? nonEmptyString(display.title) : null;
    if (!id || !title) continue;
    const url = display ? nonEmptyString(display.url) : null;
    sources.push({
      id,
      title,
      locator: display ? nonEmptyString(display.locator) : null,
      url: url && isSafeHttpUrl(url) ? url : null,
      provenance: parseProvenance(entry.provenance),
    });
  }
  return sources;
}

/**
 * The citation record SourcePreviewPanel expects for a chunk citation; the
 * same shape thread-dialogs hands it for an in-chat citation. `score` is not
 * displayed for a report row, so it is pinned at 0.
 */
export function chunkCitationRecord(
  source: ReportEvidenceSource,
  provenance: Extract<ReportEvidenceProvenance, { kind: "chunk" }>,
): CitationRecord {
  return {
    citation: source.id,
    sourceId: provenance.sourceId,
    sourceTitle: source.title,
    documentId: provenance.documentId,
    chunkId: provenance.chunkId,
    chunkNo: provenance.chunkNo,
    score: 0,
    excerpt: source.locator ?? source.title,
  };
}
