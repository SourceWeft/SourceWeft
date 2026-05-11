import type {
  BackendProtocolV2,
  EditResult,
  FileData,
  FileDownloadResponse,
  FileInfo,
  FileOperationError,
  FileUploadResponse,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "deepagents";
import type { AgentCitation, AgentCitationRegistry } from "./citation-registry";
import type { WorkingFileRecord, WorkingFilePurpose } from "../types";
import {
  WORK_ROOT,
  basename,
  normalizeWorkingFilePath,
  normalizeWorkingFsPath,
} from "../working-files";
import { workingFilesService } from "../working-files";
import {
  MAX_GLOB_RESULTS,
  MAX_GREP_RESULTS,
  compileGrepRegex,
  lineNumberContent,
  performStringReplacement,
  sanitizeNonCitableCitationMarkers,
  simpleGlobToRegExp,
} from "./fs-utils";
import { AGENT_TOOL_NAMES } from "./tool-registry";

const DEFAULT_READ_LINE_LIMIT = 500;
const DEFAULT_WORKING_FILE_MIME_TYPE = "text/plain";
const WORKFILE_CITATION_MARKER_PATTERN =
  /[[【]\u200B?citation:\s*([\w:-]+(?:\s*,\s*[\w:-]+)*)\s*\u200B?[\]】]/gi;
const FOOTNOTE_DEFINITION_PATTERN = /^\[\^([^\]\n]+)\]:\s*(.+)$/gm;
const FOOTNOTE_REFERENCE_PATTERN = /\[\^([^\]\n]+)\]/g;

function fileInfo(file: WorkingFileRecord): FileInfo {
  return {
    path: file.path,
    is_dir: false,
    size: file.sizeBytes,
    modified_at: file.updatedAt,
  };
}

function directoryInfo(path: string, modifiedAt?: string): FileInfo {
  return {
    path: path.endsWith("/") ? path : `${path}/`,
    is_dir: true,
    size: 0,
    modified_at: modifiedAt,
  };
}

function directChildPath(input: { base: string; candidate: string }) {
  if (input.base === WORK_ROOT) {
    const rest = input.candidate.slice(`${WORK_ROOT}/`.length);
    if (!rest) {
      return null;
    }
    const slashIndex = rest.indexOf("/");
    return slashIndex === -1
      ? `${WORK_ROOT}/${rest}`
      : `${WORK_ROOT}/${rest.slice(0, slashIndex)}`;
  }

  if (!input.candidate.startsWith(`${input.base}/`)) {
    return null;
  }
  const rest = input.candidate.slice(input.base.length + 1);
  if (!rest) {
    return null;
  }
  const slashIndex = rest.indexOf("/");
  return slashIndex === -1
    ? `${input.base}/${rest}`
    : `${input.base}/${rest.slice(0, slashIndex)}`;
}

function candidatePaths(files: WorkingFileRecord[]) {
  const paths = new Map<string, FileInfo>();
  for (const file of files) {
    paths.set(file.path, fileInfo(file));
    const parts = file.path.slice(`${WORK_ROOT}/`.length).split("/");
    let current = WORK_ROOT;
    for (let index = 0; index < parts.length - 1; index += 1) {
      current = `${current}/${parts[index]}`;
      paths.set(current, directoryInfo(current, file.updatedAt));
    }
  }
  return Array.from(paths.values());
}

function inferMimeType(path: string) {
  if (path.endsWith(".md") || path.endsWith(".markdown")) {
    return "text/markdown";
  }
  if (path.endsWith(".json")) {
    return "application/json";
  }
  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    return "application/yaml";
  }
  if (path.endsWith(".xml")) {
    return "application/xml";
  }
  if (path.endsWith(".toml")) {
    return "application/toml";
  }
  return DEFAULT_WORKING_FILE_MIME_TYPE;
}

function toError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function fileOperationErrorFromMessage(error: unknown): FileOperationError {
  const normalized = toError(error).toLowerCase();
  if (normalized.includes("enoent") || normalized.includes("not found") || normalized.includes("no such file")) {
    return "file_not_found";
  }
  if (normalized.includes("eisdir") || normalized.includes("directory")) {
    return "is_directory";
  }
  if (
    normalized.includes("erofs") ||
    normalized.includes("read-only") ||
    normalized.includes("not allowed") ||
    normalized.includes("permission") ||
    normalized.includes("quota") ||
    normalized.includes("size")
  ) {
    return "permission_denied";
  }
  return "invalid_path";
}

function missingWorkingFileHint(normalizedPath: string) {
  const name = basename(normalizedPath);
  if (!name) {
    return "";
  }

  return ` If '${name}' is an uploaded, selected, referenced, attached, or @mentioned source, use ${AGENT_TOOL_NAMES.searchSources} or list/read the Source Library under /kb instead of /work Workfiles.`;
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function trimSentence(value: string) {
  const compacted = compactWhitespace(value);
  if (!compacted) {
    return "";
  }
  return /[.!?]$/.test(compacted) ? compacted : `${compacted}.`;
}

function slugifyFootnoteLabel(value: string, fallback: string) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");

  return slug || fallback;
}

function uniqueFootnoteLabel(baseLabel: string, usedLabels: Set<string>) {
  let label = baseLabel;
  let suffix = 2;
  while (usedLabels.has(label)) {
    const suffixText = `-${suffix}`;
    const trimmedBase = baseLabel
      .slice(0, Math.max(1, 72 - suffixText.length))
      .replace(/-+$/g, "");
    label = `${trimmedBase}${suffixText}`;
    suffix += 1;
  }
  usedLabels.add(label);
  return label;
}

function buildWorkfileReferenceText(citation: AgentCitation) {
  const title = compactWhitespace(citation.sourceTitle || "Untitled source");
  if (citation.externalUri) {
    const lead = title ? trimSentence(title) : "Web source.";
    return `${lead} ${citation.externalUri}`;
  }
  return `Source Library: ${title || "Untitled source"}.`;
}

function buildCitationLookup(citations: AgentCitation[]) {
  const byKey = new Map<string, AgentCitation>();
  for (const citation of citations) {
    byKey.set(citation.citation, citation);
    byKey.set(citation.chunkId, citation);
  }
  return byKey;
}

function buildExistingFootnoteState(content: string) {
  const usedLabels = new Set<string>();
  const labelByReferenceText = new Map<string, string>();
  const definedLabels = new Set<string>();

  for (const match of content.matchAll(FOOTNOTE_REFERENCE_PATTERN)) {
    const label = match[1]?.trim();
    if (label) {
      usedLabels.add(label);
    }
  }

  for (const match of content.matchAll(FOOTNOTE_DEFINITION_PATTERN)) {
    const label = match[1]?.trim();
    const referenceText = compactWhitespace(match[2] ?? "");
    if (!label) {
      continue;
    }
    usedLabels.add(label);
    definedLabels.add(label);
    if (referenceText && !labelByReferenceText.has(referenceText)) {
      labelByReferenceText.set(referenceText, label);
    }
  }

  return { usedLabels, labelByReferenceText, definedLabels };
}

function appendFootnoteDefinitions(
  content: string,
  definitions: Array<{ label: string; referenceText: string }>,
) {
  if (definitions.length === 0) {
    return content;
  }

  const definitionText = definitions
    .map((definition) => `[^${definition.label}]: ${definition.referenceText}`)
    .join("\n");
  const trimmed = content.replace(/\s+$/g, "");

  if (/^## References\s*$/im.test(trimmed)) {
    return `${trimmed}\n${definitionText}`;
  }

  return `${trimmed}\n\n## References\n\n${definitionText}`;
}

export function rewriteWorkfileCitationMarkers(input: {
  content: string;
  citations: AgentCitation[];
}) {
  WORKFILE_CITATION_MARKER_PATTERN.lastIndex = 0;
  if (!WORKFILE_CITATION_MARKER_PATTERN.test(input.content)) {
    return input.content;
  }
  WORKFILE_CITATION_MARKER_PATTERN.lastIndex = 0;

  const lookup = buildCitationLookup(input.citations);
  const state = buildExistingFootnoteState(input.content);
  const labelByCitationGroup = new Map<string, string>();
  const pendingDefinitions = new Map<string, string>();

  const rewritten = input.content.replace(
    WORKFILE_CITATION_MARKER_PATTERN,
    (_marker, keysText: string) => {
      const replacementLabels: string[] = [];
      const removedKeys: string[] = [];
      const seenLabels = new Set<string>();
      const keys = keysText
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean);

      for (const key of keys) {
        const citation = lookup.get(key);
        if (!citation) {
          removedKeys.push(key);
          continue;
        }

        const groupKey =
          citation.externalUri ??
          citation.sourceId ??
          citation.documentId ??
          citation.sourceTitle;
        const referenceText = buildWorkfileReferenceText(citation);
        let label = labelByCitationGroup.get(groupKey);

        if (!label) {
          label = state.labelByReferenceText.get(referenceText);
        }
        if (!label) {
          const baseLabel = slugifyFootnoteLabel(
            citation.sourceTitle || citation.externalUri || "source",
            citation.externalUri ? "web-source" : "source",
          );
          label = uniqueFootnoteLabel(baseLabel, state.usedLabels);
        }

        labelByCitationGroup.set(groupKey, label);
        if (!state.definedLabels.has(label)) {
          pendingDefinitions.set(label, referenceText);
          state.definedLabels.add(label);
        }
        if (!seenLabels.has(label)) {
          replacementLabels.push(`[^${label}]`);
          seenLabels.add(label);
        }
      }

      if (removedKeys.length > 0) {
        replacementLabels.push(
          `[non-citable citation marker ${removedKeys.join(", ")} removed]`,
        );
      }

      return replacementLabels.join("");
    },
  );

  return appendFootnoteDefinitions(
    rewritten,
    [...pendingDefinitions].map(([label, referenceText]) => ({
      label,
      referenceText,
    })),
  );
}

export class WorkingFilesBackend implements BackendProtocolV2 {
  constructor(
    private readonly input: {
      teamId: string;
      workspaceId: string;
      threadId: string;
      userId: string;
      citationRegistry?: AgentCitationRegistry;
    },
  ) {}

  private prepareContentForPersistence(content: string) {
    const citations = this.input.citationRegistry?.list() ?? [];
    return rewriteWorkfileCitationMarkers({ content, citations });
  }

  private async files() {
    return workingFilesService.listForBackend({
      teamId: this.input.teamId,
      workspaceId: this.input.workspaceId,
      threadId: this.input.threadId,
    });
  }

  private async getFile(path: string) {
    const normalized = normalizeWorkingFilePath(path);
    const result = await workingFilesService.getWorkingFile({
      workspaceId: this.input.workspaceId,
      threadId: this.input.threadId,
      userId: this.input.userId,
      path: normalized,
    }).catch((error) => ({ error }));

    if ("error" in result) {
      return null;
    }
    return result.file;
  }

  async ls(path = WORK_ROOT): Promise<LsResult> {
    try {
      const normalized = normalizeWorkingFsPath(path || WORK_ROOT);
      if (normalized === "/") {
        return { files: [directoryInfo(WORK_ROOT)] };
      }
      const files = await this.files();
      if (normalized !== WORK_ROOT) {
        const directFile = files.find((file) => file.path === normalized);
        if (directFile) {
          return { error: `ENOTDIR: not a directory, ls '${normalized}'` };
        }
      }

      const children = new Map<string, FileInfo>();
      for (const file of files) {
        const childPath = directChildPath({ base: normalized, candidate: file.path });
        if (!childPath) {
          continue;
        }
        if (childPath === file.path) {
          children.set(childPath, fileInfo(file));
        } else {
          children.set(childPath, directoryInfo(childPath, file.updatedAt));
        }
      }

      return {
        files: Array.from(children.values()).sort((a, b) => a.path.localeCompare(b.path)),
      };
    } catch (error) {
      return { error: toError(error) };
    }
  }

  async glob(pattern: string, path = WORK_ROOT): Promise<GlobResult> {
    try {
      const base = normalizeWorkingFsPath(path);
      const normalizedPattern = pattern.startsWith("/")
        ? pattern.replace(/\/+$/g, "") || "/"
        : `${base}/${pattern}`.replace(/\/+/g, "/");
      const matcher = simpleGlobToRegExp(normalizedPattern);
      const files = await this.files();
      return {
        files: candidatePaths(files)
          .filter((candidate) => matcher.test(candidate.path.replace(/\/$/, "")))
          .sort((a, b) => a.path.localeCompare(b.path))
          .slice(0, MAX_GLOB_RESULTS),
      };
    } catch (error) {
      return { error: toError(error) };
    }
  }

  async read(filePath: string, offset = 0, limit = DEFAULT_READ_LINE_LIMIT): Promise<ReadResult> {
    try {
      const normalized = normalizeWorkingFilePath(filePath);
      const file = await this.getFile(normalized);
      if (!file) {
        return {
          error: `ENOENT: no such thread working file, ${AGENT_TOOL_NAMES.readFile} '${normalized}'.${missingWorkingFileHint(normalized)}`,
        };
      }

      const safeContent = sanitizeNonCitableCitationMarkers(file.contentText);
      const lines = lineNumberContent(safeContent).split("\n");
      const boundedOffset = Math.max(0, offset);
      const boundedLimit = Math.max(1, Math.min(limit, DEFAULT_READ_LINE_LIMIT));
      if (boundedOffset >= lines.length && lines.length > 0) {
        return { error: `Line offset ${offset} exceeds file length (${lines.length} lines)` };
      }
      const selected = lines.slice(boundedOffset, boundedOffset + boundedLimit);
      const more = boundedOffset + selected.length < lines.length
        ? `\n\nOutput truncated. Continue with ${AGENT_TOOL_NAMES.readFile}(path: "${normalized}", offset: ${boundedOffset + selected.length}, limit: ${boundedLimit}).`
        : "";

      return {
        mimeType: file.mimeType,
        content: [
          `Path: ${file.path}`,
          `Workfile: ${basename(file.path)}`,
          `MIME: ${file.mimeType}`,
          file.purpose ? `Purpose: ${file.purpose}` : null,
          "Workfiles are database-persisted thread working memory, not source evidence. Use them to continue or supplement thread work, but do not cite this file as a source.",
          "",
          selected.join("\n"),
          more,
        ].filter((line): line is string => line !== null).join("\n"),
      };
    } catch (error) {
      return { error: toError(error) };
    }
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    try {
      const normalized = normalizeWorkingFilePath(filePath);
      const file = await this.getFile(normalized);
      if (!file) {
        return {
          error: `ENOENT: no such thread working file, ${AGENT_TOOL_NAMES.readFile} '${normalized}'.${missingWorkingFileHint(normalized)}`,
        };
      }
      const data: FileData = {
        content: sanitizeNonCitableCitationMarkers(file.contentText),
        mimeType: file.mimeType,
        created_at: file.createdAt,
        modified_at: file.updatedAt,
      };
      return { data };
    } catch (error) {
      return { error: toError(error) };
    }
  }

  async grep(pattern: string, path: string | null = WORK_ROOT, glob?: string | null): Promise<GrepResult> {
    try {
      const normalized = normalizeWorkingFsPath(path || WORK_ROOT);
      const regex = compileGrepRegex(pattern);
      if (typeof regex === "string") {
        return { error: regex };
      }
      const files = await this.files();
      const matcher = glob
        ? simpleGlobToRegExp(
            glob.startsWith("/")
              ? glob.replace(/\/+$/g, "") || "/"
              : `${normalized}/${glob}`.replace(/\/+/g, "/"),
          )
        : null;
      const targetFiles = files.filter((file) =>
        file.path === normalized ||
        normalized === WORK_ROOT ||
        file.path.startsWith(`${normalized}/`)
      );
      const matches: GrepMatch[] = [];
      for (const file of targetFiles) {
        if (matcher && !matcher.test(file.path)) {
          continue;
        }
        const lines = file.contentText.split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          if (matches.length >= MAX_GREP_RESULTS) {
            return { matches };
          }
          if (regex.test(line)) {
            matches.push({
              path: file.path,
              line: index + 1,
              text: sanitizeNonCitableCitationMarkers(line.trim()),
            });
          }
        }
      }
      return { matches };
    } catch (error) {
      return { error: toError(error) };
    }
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    try {
      const normalized = normalizeWorkingFilePath(filePath);
      const result = await workingFilesService.putWorkingFile({
        workspaceId: this.input.workspaceId,
        threadId: this.input.threadId,
        userId: this.input.userId,
        path: normalized,
        contentText: this.prepareContentForPersistence(content),
        mimeType: inferMimeType(normalized),
      });
      return {
        path: result.file.path,
        filesUpdate: null,
        metadata: { sizeBytes: result.file.sizeBytes },
      };
    } catch (error) {
      return { error: toError(error) };
    }
  }

  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ): Promise<EditResult> {
    try {
      const normalized = normalizeWorkingFilePath(filePath);
      const file = await this.getFile(normalized);
      if (!file) {
        return { error: `Error: File '${normalized}' not found` };
      }
      const replacement = performStringReplacement(
        file.contentText,
        oldString,
        newString,
        replaceAll,
      );
      if (typeof replacement === "string") {
        return { error: replacement };
      }
      const [contentText, occurrences] = replacement;
      const result = await workingFilesService.putWorkingFile({
        workspaceId: this.input.workspaceId,
        threadId: this.input.threadId,
        userId: this.input.userId,
        path: normalized,
        contentText: this.prepareContentForPersistence(contentText),
        mimeType: file.mimeType,
        purpose: file.purpose as WorkingFilePurpose | null,
      });
      return {
        path: result.file.path,
        filesUpdate: null,
        occurrences,
        metadata: { sizeBytes: result.file.sizeBytes },
      };
    } catch (error) {
      return { error: toError(error) };
    }
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const encoder = new TextEncoder();
    return Promise.all(
      paths.map(async (filePath) => {
        try {
          const normalized = normalizeWorkingFilePath(filePath);
          const file = await this.getFile(normalized);
          if (!file) {
            return { path: filePath, content: null, error: "file_not_found" as const };
          }
          return {
            path: filePath,
            content: encoder.encode(sanitizeNonCitableCitationMarkers(file.contentText)),
            error: null,
          };
        } catch {
          return { path: filePath, content: null, error: "invalid_path" as const };
        }
      }),
    );
  }

  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    const decoder = new TextDecoder();
    return Promise.all(
      files.map(async ([filePath, content]) => {
        try {
          const normalized = normalizeWorkingFilePath(filePath);
          await workingFilesService.putWorkingFile({
            workspaceId: this.input.workspaceId,
            threadId: this.input.threadId,
            userId: this.input.userId,
            path: normalized,
            contentText: this.prepareContentForPersistence(decoder.decode(content)),
            mimeType: inferMimeType(normalized),
          });
          return { path: filePath, error: null };
        } catch (error) {
          return { path: filePath, error: fileOperationErrorFromMessage(error) };
        }
      }),
    );
  }
}
