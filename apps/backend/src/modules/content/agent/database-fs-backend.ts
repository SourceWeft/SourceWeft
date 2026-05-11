import type {
  BackendProtocolV2,
  EditResult,
  FileInfo,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from "deepagents";
import type { AgentCitationRegistry } from "./citation-registry";
import {
  KB_READ_FILE_DEFAULT_LINE_LIMIT,
  KB_READ_FILE_MAX_LINE_LIMIT,
} from "./filesystem-capabilities";
import { logger } from "../../../shared/logger";
import { AGENT_TOOL_NAMES } from "./tool-registry";
import {
  MAX_GLOB_RESULTS,
  MAX_GREP_RESULTS,
  compileGrepRegex,
  formatTimestamp,
  lineNumberContent,
  simpleGlobToRegExp,
} from "./fs-utils";
import {
  buildChunkFilePath,
  findVirtualSource,
  normalizeVirtualPath,
  parseVirtualPath,
} from "../virtual-fs/paths";
import {
  getVirtualFsDocument,
  getVirtualFsChunk,
  grepVirtualFsChunksByRecallTerms,
  grepVirtualFsChunksByRegex,
  listVirtualFsChunks,
  listVirtualFsChunksForSpan,
  listVirtualFsSources,
} from "../virtual-fs/store";
import type { VirtualFsChunk, VirtualFsSource } from "../virtual-fs/types";

const DEFAULT_READ_LINE_LIMIT = KB_READ_FILE_DEFAULT_LINE_LIMIT;
const MAX_READ_LINE_LIMIT = KB_READ_FILE_MAX_LINE_LIMIT;
const MAX_READ_OUTPUT_CHARS = 80_000;
const MAX_READ_VISIBLE_CITATIONS = 24;
const MAX_GREP_RECALL_TOP_K = 300;
const MAX_GREP_REGEX_FALLBACK_CHUNKS = 300;
const MAX_GREP_FALLBACK_CHUNKS = 120;
const MAX_GREP_RECALL_TERMS = 8;

export function normalizeGrepGlobPattern(glob: string | null | undefined, path: string | null | undefined) {
  if (!glob || glob.trim().length === 0) {
    return "**";
  }

  const trimmed = glob.trim();
  if (trimmed === "*" || trimmed === "**") {
    return "**";
  }

  if (trimmed.startsWith("/")) {
    return trimmed.replace(/\/+$/g, "") || "/";
  }

  const base = normalizeVirtualPath(path || "/kb");
  return `${base}/${trimmed}`.replace(/\/+/g, "/");
}

export function buildGrepGlobMatcher(glob: string | null | undefined, path: string | null | undefined) {
  return simpleGlobToRegExp(normalizeGrepGlobPattern(glob, path));
}

export function matchesGrepGlob(input: {
  glob: string | null | undefined;
  globMatcher: RegExp;
  sourceFilePath: string | null;
  sourceTitlePath?: string | null;
  chunkPath: string;
}) {
  return (
    !input.glob ||
    input.globMatcher.test(input.chunkPath) ||
    (typeof input.sourceFilePath === "string" &&
      input.globMatcher.test(input.sourceFilePath)) ||
    (typeof input.sourceTitlePath === "string" &&
      input.globMatcher.test(input.sourceTitlePath))
  );
}

function extractSearchTermsForRegex(pattern: string) {
  const normalized = pattern
    .replace(/^\(\?i\)/, " ")
    .replace(/\\[dDsSwWbB]/g, " ")
    .replace(/\\[pP]\{[^}]+\}/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\{\d+(?:,\d*)?\}/g, " ")
    .replace(/\\([\\.^$*+?()[\]{}|/-])/g, "$1");
  const terms = normalized.match(/[\p{L}\p{N}_./:-]+/gu) ?? [];

  return Array.from(
    new Set(
      terms
        .map((term) => term.toLowerCase())
        .filter((term) => /[\p{L}\p{N}]/u.test(term)),
    ),
  )
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_GREP_RECALL_TERMS);
}

function buildSourceHeader(source: VirtualFsSource) {
  const originalFile = source.fileName?.trim() || source.title;
  return [
    `Source: ${source.title}`,
    source.sourceType === "directory" ? "Library entry: directory README" : null,
    originalFile ? `Original file: ${originalFile}` : null,
    source.mimeType ? `Original MIME: ${source.mimeType}` : null,
    "Virtual MIME: text/markdown",
  ].filter((line): line is string => line !== null);
}

function buildCandidatePaths(sources: VirtualFsSource[], includeChunks: boolean) {
  const paths: FileInfo[] = [];
  for (const source of sources) {
    const modifiedAt = formatTimestamp(source.updatedAt);
    paths.push({ path: `${source.dirPath}/`, is_dir: true, modified_at: modifiedAt });
    if (source.readmePath) {
      paths.push({ path: source.readmePath, is_dir: false, modified_at: modifiedAt });
    }
    if (source.filePath) {
      paths.push({ path: source.filePath, is_dir: false, modified_at: modifiedAt });
    }
    if (includeChunks) {
      for (let chunkNo = 0; chunkNo < source.chunkCount; chunkNo += 1) {
        paths.push({ path: buildChunkFilePath(source, chunkNo), is_dir: false, modified_at: modifiedAt });
      }
    }
  }
  return paths;
}

function appendRegexMatches(input: {
  matches: GrepMatch[];
  regex: RegExp;
  source: VirtualFsSource;
  documentId: string;
  chunkId: string;
  chunkNo: number;
  content: string;
  glob?: string | null;
  globMatcher: RegExp;
  citationRegistry: AgentCitationRegistry;
}) {
  const chunkPath = buildChunkFilePath(input.source, input.chunkNo);
  if (!matchesGrepGlob({
    glob: input.glob,
    globMatcher: input.globMatcher,
    sourceFilePath: input.source.filePath,
    chunkPath,
  })) {
    return;
  }

  const lines = input.content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (input.matches.length >= MAX_GREP_RESULTS) {
      return;
    }
    if (input.regex.test(line)) {
      const citation = input.citationRegistry.addChunk({
        origin: AGENT_TOOL_NAMES.grep,
        sourceId: input.source.sourceId,
        sourceTitle: input.source.title,
        documentId: input.documentId,
        chunkId: input.chunkId,
        chunkNo: input.chunkNo,
        content: input.content,
        score: 1,
        path: chunkPath,
      });
      input.matches.push({
        path: chunkPath,
        line: index + 1,
        text: `${line.trim()} [citation:${citation.citation}]`,
      });
    }
  }
}

function sourceReadablePath(source: VirtualFsSource) {
  return source.filePath ?? source.readmePath ?? source.dirPath;
}

export type PaginatedSourceContent = {
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  nextOffset: number | null;
  pageStartOffset: number;
  pageEndOffset: number;
  truncated: boolean;
};

export function computeLineStartOffsets(content: string) {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code === 13) {
      if (content.charCodeAt(index + 1) === 10) {
        offsets.push(index + 2);
        index += 1;
      } else {
        offsets.push(index + 1);
      }
    } else if (code === 10) {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

export function lineForOffset(lineStartOffsets: number[], offset: number) {
  if (lineStartOffsets.length === 0) {
    return 1;
  }
  let low = 0;
  let high = lineStartOffsets.length - 1;
  const boundedOffset = Math.max(0, offset);

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = lineStartOffsets[middle] ?? 0;
    if (value <= boundedOffset) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return Math.max(1, high + 1);
}

function boundedReadLineLimit(limit: number) {
  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_READ_LINE_LIMIT;
  return Math.max(1, Math.min(requestedLimit, MAX_READ_LINE_LIMIT));
}

export function paginateSourceContent(
  content: string,
  offset = 0,
  limit = DEFAULT_READ_LINE_LIMIT,
  maxChars = MAX_READ_OUTPUT_CHARS,
): PaginatedSourceContent {
  const lineStartOffsets = computeLineStartOffsets(content);
  const totalLines = content.length === 0 ? 0 : lineStartOffsets.length;
  const requestedOffset = Number.isFinite(offset) ? Math.floor(offset) : 0;
  const boundedOffset = Math.max(0, requestedOffset);
  const boundedLimit = boundedReadLineLimit(limit);

  if (totalLines === 0) {
    return {
      text: "",
      startLine: 0,
      endLine: 0,
      totalLines: 0,
      nextOffset: null,
      pageStartOffset: 0,
      pageEndOffset: 0,
      truncated: false,
    };
  }

  if (boundedOffset >= totalLines) {
    throw new Error(`Line offset ${offset} exceeds file length (${totalLines} lines)`);
  }

  const startLineIndex = boundedOffset;
  let endLineIndexExclusive = Math.min(totalLines, boundedOffset + boundedLimit);
  const pageStartOffset = lineStartOffsets[startLineIndex] ?? 0;
  let pageEndOffset = endLineIndexExclusive < totalLines
    ? (lineStartOffsets[endLineIndexExclusive] ?? content.length)
    : content.length;
  let truncated = endLineIndexExclusive < totalLines;

  if (pageEndOffset - pageStartOffset > maxChars) {
    const maxEndOffset = pageStartOffset + maxChars;
    let charBoundedEndLine = startLineIndex + 1;
    while (
      charBoundedEndLine < endLineIndexExclusive &&
      (lineStartOffsets[charBoundedEndLine] ?? content.length) <= maxEndOffset
    ) {
      charBoundedEndLine += 1;
    }
    endLineIndexExclusive = Math.max(startLineIndex + 1, charBoundedEndLine);
    pageEndOffset = endLineIndexExclusive < totalLines
      ? (lineStartOffsets[endLineIndexExclusive] ?? content.length)
      : content.length;
    truncated = true;
  }

  return {
    text: content.slice(pageStartOffset, pageEndOffset).replace(/\r\n?/g, "\n").replace(/\n$/, ""),
    startLine: startLineIndex + 1,
    endLine: endLineIndexExclusive,
    totalLines,
    nextOffset: truncated ? endLineIndexExclusive : null,
    pageStartOffset,
    pageEndOffset,
    truncated,
  };
}

export function addInlineSourceMarkers(input: {
  text: string;
  startLine: number;
  nextOffset: number | null;
  sourcePath: string;
  limit: number;
  citations: Array<{ chunk: VirtualFsChunk; citation: string }>;
  lineStartOffsets: number[];
}) {
  const lines = input.text.split("\n");
  if (lines.length === 0) {
    return input.text;
  }

  const markersByLine = new Map<number, string[]>();
  for (const item of input.citations) {
    const offset = typeof item.chunk.startOffset === "number" ? item.chunk.startOffset : 0;
    const line = Math.max(input.startLine, lineForOffset(input.lineStartOffsets, offset));
    const lineIndex = Math.min(lines.length - 1, Math.max(0, line - input.startLine));
    const markers = markersByLine.get(lineIndex) ?? [];
    markers.push(`[citation:${item.citation}]`);
    markersByLine.set(lineIndex, markers);
  }

  for (const [lineIndex, markers] of [...markersByLine.entries()].sort((a, b) => a[0] - b[0])) {
    lines[lineIndex] = `${lines[lineIndex]} ${Array.from(new Set(markers)).join(" ")}`;
  }

  if (input.nextOffset !== null) {
    const lastIndex = lines.length - 1;
    lines[lastIndex] = `${lines[lastIndex]} [Output truncated. Continue with ${AGENT_TOOL_NAMES.readFile}(file_path: "${input.sourcePath}", offset: ${input.nextOffset}, limit: ${input.limit}).]`;
  }

  return lines.join("\n");
}

function listDirectChildren(sources: VirtualFsSource[], parentSourceId: string | null) {
  return sources.filter((source) => source.parentSourceId === parentSourceId);
}

function listDescendantSources(sources: VirtualFsSource[], sourceId: string) {
  const descendants: VirtualFsSource[] = [];
  const visited = new Set<string>([sourceId]);
  let frontier = [sourceId];

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const source of sources) {
      if (!source.parentSourceId || !frontier.includes(source.parentSourceId) || visited.has(source.sourceId)) {
        continue;
      }
      visited.add(source.sourceId);
      descendants.push(source);
      next.push(source.sourceId);
    }
    frontier = next;
  }

  return descendants;
}

function buildTreeEntry(source: VirtualFsSource): FileInfo {
  const modifiedAt = formatTimestamp(source.updatedAt);
  if (source.sourceType === "directory") {
    return { path: `${source.dirPath}/`, is_dir: true, modified_at: modifiedAt };
  }
  return {
    path: source.filePath ?? source.dirPath,
    is_dir: false,
    modified_at: modifiedAt,
  };
}

function countChunks(sources: VirtualFsSource[]) {
  return sources.reduce((sum, source) => sum + source.chunkCount, 0);
}

export class DatabaseKnowledgeBackend implements BackendProtocolV2 {
  constructor(
    private readonly input: {
      teamId: string;
      workspaceId: string;
      sourceIds: string[];
      citationRegistry: AgentCitationRegistry;
    },
  ) {}

  private async sources() {
    return listVirtualFsSources({
      teamId: this.input.teamId,
      workspaceId: this.input.workspaceId,
      sourceIds: this.input.sourceIds,
    });
  }

  async ls(path: string): Promise<LsResult> {
    try {
      const sources = await this.sources();
      const target = parseVirtualPath(path || "/kb", sources);
      if (target.kind === "root") {
        return { files: [{ path: "/kb/", is_dir: true }] };
      }
      if (target.kind === "kbRoot") {
        return { files: listDirectChildren(sources, null).map(buildTreeEntry) };
      }
      if (target.kind === "libraryDirectory") {
        const source = findVirtualSource(sources, target.sourceId);
        const files: FileInfo[] = [];
        if (source.readmePath) {
          files.push({
            path: source.readmePath,
            is_dir: false,
            modified_at: formatTimestamp(source.updatedAt),
          });
        }
        files.push(...listDirectChildren(sources, source.sourceId).map(buildTreeEntry));
        return { files };
      }
      if (target.kind === "sourceChunksDir") {
        const source = findVirtualSource(sources, target.sourceId);
        return {
          files: Array.from({ length: source.chunkCount }, (_, chunkNo) => ({
            path: buildChunkFilePath(source, chunkNo),
            is_dir: false,
            modified_at: formatTimestamp(source.updatedAt),
          })),
        };
      }
      return { error: `ENOTDIR: not a directory, ls '${normalizeVirtualPath(path)}'` };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async glob(pattern: string, path = "/"): Promise<GlobResult> {
    try {
      const sources = await this.sources();
      const base = normalizeVirtualPath(path);
      const normalizedPattern = pattern.startsWith("/") ? pattern : `${base}/${pattern}`.replace(/\/+/g, "/");
      const includeChunks = normalizedPattern.includes("chunks") || normalizedPattern.includes("**");
      const matcher = simpleGlobToRegExp(normalizedPattern);
      return {
        files: buildCandidatePaths(sources, includeChunks)
          .filter((candidate) => matcher.test(candidate.path))
          .slice(0, MAX_GLOB_RESULTS),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async read(filePath: string, offset = 0, limit = DEFAULT_READ_LINE_LIMIT): Promise<ReadResult> {
    try {
      const sources = await this.sources();
      const target = parseVirtualPath(filePath, sources);
      if (target.kind === "chunkFile") {
        const source = findVirtualSource(sources, target.sourceId);
        const chunk = await getVirtualFsChunk({
          teamId: this.input.teamId,
          workspaceId: this.input.workspaceId,
          sourceId: target.sourceId,
          chunkNo: target.chunkNo,
        });
        if (!chunk) {
          return { error: `ENOENT: no such chunk, ${AGENT_TOOL_NAMES.readFile} '${filePath}'` };
        }
        const citation = this.input.citationRegistry.addChunk({
          origin: AGENT_TOOL_NAMES.readFile,
          sourceId: chunk.sourceId,
          sourceTitle: chunk.sourceTitle,
          documentId: chunk.documentId,
          chunkId: chunk.chunkId,
          chunkNo: chunk.chunkNo,
          content: chunk.content,
          score: 1,
          path: buildChunkFilePath(source, chunk.chunkNo),
        });
        return {
          mimeType: "text/markdown",
          content: [
            `Path: ${buildChunkFilePath(source, chunk.chunkNo)}`,
            ...buildSourceHeader(source),
            `Chunk: ${chunk.chunkNo}`,
            chunk.headingPath ? `Heading: ${chunk.headingPath}` : null,
            `Citation: [citation:${citation.citation}]`,
            "",
            lineNumberContent(chunk.content),
          ]
            .filter((line): line is string => line !== null)
            .join("\n"),
        };
      }

      if (target.kind === "sourceFile" || target.kind === "libraryDirectoryReadme") {
        const source = findVirtualSource(sources, target.sourceId);
        const document = await getVirtualFsDocument({
          teamId: this.input.teamId,
          workspaceId: this.input.workspaceId,
          sourceId: target.sourceId,
        });
        const content = document?.content ?? null;
        if (content === null || content.trim().length === 0) {
          if (target.kind === "libraryDirectoryReadme") {
            return {
              mimeType: "text/markdown",
              content: [
                `Path: ${source.readmePath ?? filePath}`,
                ...buildSourceHeader(source),
                "This directory has no indexed README context yet. Directory names and paths alone are not citable evidence.",
                "",
                `# ${source.title}`,
              ].join("\n"),
            };
          }
          return { error: `ENOENT: no readable content, ${AGENT_TOOL_NAMES.readFile} '${filePath}'` };
        }

        let page: PaginatedSourceContent;
        try {
          page = paginateSourceContent(content, offset, limit);
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }

        const lineStartOffsets = computeLineStartOffsets(content);
        const visibleChunks = page.pageEndOffset > page.pageStartOffset
          ? await listVirtualFsChunksForSpan({
              teamId: this.input.teamId,
              workspaceId: this.input.workspaceId,
              sourceId: target.sourceId,
              startOffset: page.pageStartOffset,
              endOffset: page.pageEndOffset,
              limit: MAX_READ_VISIBLE_CITATIONS,
            })
          : [];
        const citations = [...visibleChunks].sort((a, b) => {
          const left = a.startOffset ?? Number.MAX_SAFE_INTEGER;
          const right = b.startOffset ?? Number.MAX_SAFE_INTEGER;
          return left - right || a.chunkNo - b.chunkNo;
        }).map((chunk) => {
          const chunkPath = buildChunkFilePath(source, chunk.chunkNo);
          const citation = this.input.citationRegistry.addChunk({
            origin: AGENT_TOOL_NAMES.readFile,
            sourceId: chunk.sourceId,
            sourceTitle: chunk.sourceTitle,
            documentId: chunk.documentId,
            chunkId: chunk.chunkId,
            chunkNo: chunk.chunkNo,
            content: chunk.content,
            score: 1,
            path: chunkPath,
          });
          return {
            chunk,
            citation: citation.citation,
          };
        });
        const pageText = addInlineSourceMarkers({
          text: page.text,
          startLine: page.startLine,
          nextOffset: page.nextOffset,
          sourcePath: sourceReadablePath(source),
          limit: boundedReadLineLimit(limit),
          citations,
          lineStartOffsets,
        });
        return {
          mimeType: "text/markdown",
          content: pageText,
        };
      }

      return { error: `EISDIR: is a directory, ${AGENT_TOOL_NAMES.readFile} '${normalizeVirtualPath(filePath)}'` };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    try {
      return {
        error: `EROFS: /kb raw downloads are disabled; use ${AGENT_TOOL_NAMES.searchSources}, /kb ${AGENT_TOOL_NAMES.readFile}, or /kb ${AGENT_TOOL_NAMES.grep} to gather citable evidence for '${normalizeVirtualPath(filePath)}'`,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async grep(pattern: string, path: string | null = "/kb", glob?: string | null): Promise<GrepResult> {
    const startedAt = Date.now();
    const logContext = {
      teamId: this.input.teamId,
      workspaceId: this.input.workspaceId,
      sourceIdsCount: this.input.sourceIds?.length ?? 0,
      pattern,
      path: path || "/kb",
      glob: glob ?? null,
    };

    try {
      const sources = await this.sources();
      const target = parseVirtualPath(path || "/kb", sources);
      const regex = compileGrepRegex(pattern);
      if (typeof regex === "string") {
        logger.warn("Database knowledge grep rejected invalid pattern", {
          ...logContext,
          error: regex,
          latencyMs: Date.now() - startedAt,
        });
        return { error: regex };
      }

      const matcher = buildGrepGlobMatcher(glob, path || "/kb");
      const matches: GrepMatch[] = [];
      let globMatchedChunkCount = 0;

      if (target.kind === "chunkFile") {
        const source = findVirtualSource(sources, target.sourceId);
        const chunk = await getVirtualFsChunk({
          teamId: this.input.teamId,
          workspaceId: this.input.workspaceId,
          sourceId: target.sourceId,
          chunkNo: target.chunkNo,
        });
        if (!chunk) {
          logger.warn("Database knowledge grep chunk not found", {
            ...logContext,
            sourceId: target.sourceId,
            chunkNo: target.chunkNo,
            latencyMs: Date.now() - startedAt,
          });
          return { error: `ENOENT: no such chunk, grep '${path}'` };
        }
        if (matchesGrepGlob({
          glob,
          globMatcher: matcher,
          sourceFilePath: source.filePath,
          chunkPath: buildChunkFilePath(source, chunk.chunkNo),
        })) {
          globMatchedChunkCount += 1;
        }
        appendRegexMatches({
          matches,
          regex,
          source,
          documentId: chunk.documentId,
          chunkId: chunk.chunkId,
          chunkNo: chunk.chunkNo,
          content: chunk.content,
          glob,
          globMatcher: matcher,
          citationRegistry: this.input.citationRegistry,
        });
        logger.debug("Database knowledge grep completed", {
          ...logContext,
          strategy: "chunk-file",
          sourceId: target.sourceId,
          chunkNo: target.chunkNo,
          matchCount: matches.length,
          globMatchedChunkCount,
          truncated: matches.length >= MAX_GREP_RESULTS,
          latencyMs: Date.now() - startedAt,
        });
        return { matches };
      }

      const targetSources = (() => {
        if (
          target.kind === "sourceFile" ||
          target.kind === "libraryDirectoryReadme" ||
          target.kind === "sourceChunksDir"
        ) {
          return [findVirtualSource(sources, target.sourceId)];
        }
        if (target.kind === "libraryDirectory") {
          return [
            findVirtualSource(sources, target.sourceId),
            ...listDescendantSources(sources, target.sourceId),
          ];
        }
        return sources;
      })();
      const sourceIds = targetSources.map((source) => source.sourceId);
      const fallbackChunkCount = countChunks(targetSources);

      if (fallbackChunkCount <= MAX_GREP_FALLBACK_CHUNKS) {
        for (const source of targetSources) {
          const chunks = await listVirtualFsChunks({
            teamId: this.input.teamId,
            workspaceId: this.input.workspaceId,
            sourceId: source.sourceId,
            offset: 0,
            limit: source.chunkCount,
          });
          for (const chunk of chunks) {
            if (matchesGrepGlob({
              glob,
              globMatcher: matcher,
              sourceFilePath: source.filePath,
              chunkPath: buildChunkFilePath(source, chunk.chunkNo),
            })) {
              globMatchedChunkCount += 1;
            }
            appendRegexMatches({
              matches,
              regex,
              source,
              documentId: chunk.documentId,
              chunkId: chunk.chunkId,
              chunkNo: chunk.chunkNo,
              content: chunk.content,
              glob,
              globMatcher: matcher,
              citationRegistry: this.input.citationRegistry,
            });
            if (matches.length >= MAX_GREP_RESULTS) {
              break;
            }
          }
          if (matches.length >= MAX_GREP_RESULTS) {
            break;
          }
        }
        logger.debug("Database knowledge grep completed", {
          ...logContext,
          strategy: "small-scope-scan",
          sourceCount: targetSources.length,
          fallbackChunkCount,
          matchCount: matches.length,
          globMatchedChunkCount,
          truncated: matches.length >= MAX_GREP_RESULTS,
          latencyMs: Date.now() - startedAt,
        });
        return { matches };
      }

      const recallTerms = extractSearchTermsForRegex(pattern);
      if (recallTerms.length === 0) {
        logger.warn("Database knowledge grep rejected broad regex", {
          ...logContext,
          sourceCount: targetSources.length,
          fallbackChunkCount,
          latencyMs: Date.now() - startedAt,
        });
        return {
          error: `Regex pattern '${pattern}' has no literal terms for indexed recall, and the current /kb scope has ${fallbackChunkCount} chunks. Narrow grep to a specific /kb source or chunk path, select fewer sources, or include a literal term in the pattern.`,
        };
      }

      const candidates = await grepVirtualFsChunksByRecallTerms({
        teamId: this.input.teamId,
        workspaceId: this.input.workspaceId,
        sourceIds,
        terms: recallTerms,
        totalTopK: MAX_GREP_RECALL_TOP_K,
      });

      for (const candidate of candidates) {
        const source = sources.find((item) => item.sourceId === candidate.sourceId);
        if (!source) {
          continue;
        }
        if (matchesGrepGlob({
          glob,
          globMatcher: matcher,
          sourceFilePath: source.filePath,
          chunkPath: buildChunkFilePath(source, candidate.chunkNo),
        })) {
          globMatchedChunkCount += 1;
        }
        appendRegexMatches({
          matches,
          regex,
          source,
          documentId: candidate.documentId,
          chunkId: candidate.chunkId,
          chunkNo: candidate.chunkNo,
          content: candidate.content,
          glob,
          globMatcher: matcher,
          citationRegistry: this.input.citationRegistry,
        });
        if (matches.length >= MAX_GREP_RESULTS) {
          break;
        }
      }

      if (matches.length === 0) {
        const regexCandidates = await grepVirtualFsChunksByRegex({
          teamId: this.input.teamId,
          workspaceId: this.input.workspaceId,
          sourceIds,
          pattern,
          limit: MAX_GREP_REGEX_FALLBACK_CHUNKS,
        }).catch(() => []);

        logger.info("Database knowledge grep using regex fallback", {
          ...logContext,
          sourceCount: targetSources.length,
          fallbackChunkCount,
          recallTerms,
          recallCandidateCount: candidates.length,
          regexCandidateCount: regexCandidates.length,
        });

        for (const candidate of regexCandidates) {
          const source = sources.find((item) => item.sourceId === candidate.sourceId);
          if (!source) {
            continue;
          }
          if (matchesGrepGlob({
            glob,
            globMatcher: matcher,
            sourceFilePath: source.filePath,
            chunkPath: buildChunkFilePath(source, candidate.chunkNo),
          })) {
            globMatchedChunkCount += 1;
          }
          appendRegexMatches({
            matches,
            regex,
            source,
            documentId: candidate.documentId,
            chunkId: candidate.chunkId,
            chunkNo: candidate.chunkNo,
            content: candidate.content,
            glob,
            globMatcher: matcher,
            citationRegistry: this.input.citationRegistry,
          });
          if (matches.length >= MAX_GREP_RESULTS) {
            break;
          }
        }
      }

      logger.debug("Database knowledge grep completed", {
        ...logContext,
        strategy: "indexed-recall",
        sourceCount: targetSources.length,
        fallbackChunkCount,
        recallTerms,
        recallCandidateCount: candidates.length,
        matchCount: matches.length,
        globMatchedChunkCount,
        truncated: matches.length >= MAX_GREP_RESULTS,
        latencyMs: Date.now() - startedAt,
      });
      return { matches };
    } catch (error) {
      logger.error("Database knowledge grep failed", {
        ...logContext,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      });
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async write(filePath: string, _content: string): Promise<WriteResult> {
    return { error: `EROFS: /kb is a read-only database-backed filesystem, write '${filePath}' is not allowed` };
  }

  async edit(filePath: string, _oldString: string, _newString: string, _replaceAll?: boolean): Promise<EditResult> {
    return { error: `EROFS: /kb is a read-only database-backed filesystem, edit '${filePath}' is not allowed` };
  }
}
