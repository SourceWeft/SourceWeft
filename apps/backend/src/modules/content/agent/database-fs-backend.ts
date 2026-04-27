import type {
  BackendProtocolV2,
  EditResult,
  FileData,
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
  buildChunkFilePath,
  findVirtualSource,
  normalizeVirtualPath,
  parseVirtualPath,
} from "../virtual-fs/paths";
import {
  getVirtualFsChunk,
  grepVirtualFsChunks,
  listVirtualFsChunks,
  listVirtualFsSources,
} from "../virtual-fs/store";
import type { VirtualFsSource } from "../virtual-fs/types";

const DEFAULT_READ_CHUNK_LIMIT = 6;
const MAX_READ_CHUNK_LIMIT = 12;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_RESULTS = 50;
const MAX_GREP_RECALL_TOP_K = 300;
const MAX_GREP_FALLBACK_CHUNKS = 120;
const MAX_GREP_RECALL_TERMS = 8;

function simpleGlobToRegExp(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`, "i");
}

function compileGrepRegex(pattern: string) {
  const normalized = pattern.trim().replace(/^\(\?i\)/, "");
  if (normalized.length === 0) {
    return "grep pattern must not be empty";
  }

  try {
    return new RegExp(normalized, "i");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Invalid regex pattern '${pattern}': ${message}`;
  }
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

function lineNumberContent(content: string) {
  return content
    .split(/\r?\n/)
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n");
}

function buildCandidatePaths(sources: VirtualFsSource[], includeChunks: boolean) {
  const paths: FileInfo[] = [];
  for (const source of sources) {
    const modifiedAt = formatTimestamp(source.updatedAt);
    paths.push({ path: source.filePath, is_dir: false, size: source.sizeBytes ?? undefined, modified_at: modifiedAt });
    paths.push({ path: `${source.dirPath}/`, is_dir: true, modified_at: modifiedAt });
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
  chunkNo: number;
  content: string;
  glob?: string | null;
  globMatcher: RegExp;
}) {
  const chunkPath = buildChunkFilePath(input.source, input.chunkNo);
  if (input.glob && !input.globMatcher.test(chunkPath)) {
    return;
  }

  const lines = input.content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (input.matches.length >= MAX_GREP_RESULTS) {
      return;
    }
    if (input.regex.test(line)) {
      input.matches.push({ path: chunkPath, line: index + 1, text: line.trim() });
    }
  }
}

function countChunks(sources: VirtualFsSource[]) {
  return sources.reduce((sum, source) => sum + source.chunkCount, 0);
}

function formatTimestamp(value: Date | string | number | null | undefined) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  if (typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}

export class DatabaseKnowledgeBackend implements BackendProtocolV2 {
  constructor(
    private readonly input: {
      teamId: string;
      workspaceId: string;
      sourceIds?: string[];
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
        return { files: buildCandidatePaths(sources, false) };
      }
      if (target.kind === "sourceDir") {
        const source = findVirtualSource(sources, target.sourceId);
        return { files: [{ path: `${source.dirPath}/chunks/`, is_dir: true }] };
      }
      if (target.kind === "chunksDir") {
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

  async read(filePath: string, offset = 0, limit = DEFAULT_READ_CHUNK_LIMIT): Promise<ReadResult> {
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
          return { error: `ENOENT: no such chunk, read_file '${filePath}'` };
        }
        const citation = this.input.citationRegistry.addChunk({
          origin: "read_file",
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
            `Source: ${chunk.sourceTitle}`,
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

      if (target.kind === "sourceFile") {
        const source = findVirtualSource(sources, target.sourceId);
        const boundedLimit = Math.max(1, Math.min(limit, MAX_READ_CHUNK_LIMIT));
        const boundedOffset = Math.max(0, offset);
        const chunks = await listVirtualFsChunks({
          teamId: this.input.teamId,
          workspaceId: this.input.workspaceId,
          sourceId: target.sourceId,
          offset: boundedOffset,
          limit: boundedLimit,
        });
        if (chunks.length === 0) {
          return { error: `ENOENT: no readable chunks, read_file '${filePath}'` };
        }

        const sections = chunks.map((chunk) => {
          const chunkPath = buildChunkFilePath(source, chunk.chunkNo);
          const citation = this.input.citationRegistry.addChunk({
            origin: "read_file",
            sourceId: chunk.sourceId,
            sourceTitle: chunk.sourceTitle,
            documentId: chunk.documentId,
            chunkId: chunk.chunkId,
            chunkNo: chunk.chunkNo,
            content: chunk.content,
            score: 1,
            path: chunkPath,
          });
          return [
            `--- chunk ${String(chunk.chunkNo).padStart(4, "0")} | Path: ${chunkPath} | Citation: [citation:${citation.citation}] ---`,
            chunk.headingPath ? `Heading: ${chunk.headingPath}` : null,
            lineNumberContent(chunk.content),
          ]
            .filter((line): line is string => line !== null)
            .join("\n");
        });

        const more = boundedOffset + chunks.length < source.chunkCount
          ? `\n\nOutput truncated. Continue with read_file(path: "${source.filePath}", offset: ${boundedOffset + chunks.length}, limit: ${boundedLimit}) or read a specific chunk path.`
          : "";
        return {
          mimeType: "text/markdown",
          content: [
            `Path: ${source.filePath}`,
            `Source: ${source.title}`,
            "This virtual file is assembled from indexed chunks. Cite facts using the citation shown for the relevant chunk.",
            "",
            sections.join("\n\n"),
            more,
          ].join("\n"),
        };
      }

      return { error: `EISDIR: is a directory, read_file '${normalizeVirtualPath(filePath)}'` };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    const result = await this.read(filePath, 0, MAX_READ_CHUNK_LIMIT);
    if (result.error || typeof result.content !== "string") {
      return { error: result.error ?? `Unable to read raw file '${filePath}'` };
    }
    const now = new Date().toISOString();
    const data: FileData = {
      content: result.content,
      mimeType: result.mimeType ?? "text/markdown",
      created_at: now,
      modified_at: now,
    };
    return { data };
  }

  async grep(pattern: string, path: string | null = "/kb", glob?: string | null): Promise<GrepResult> {
    try {
      const sources = await this.sources();
      const target = parseVirtualPath(path || "/kb", sources);
      const regex = compileGrepRegex(pattern);
      if (typeof regex === "string") {
        return { error: regex };
      }

      const matcher = simpleGlobToRegExp(glob || "**");
      const matches: GrepMatch[] = [];

      if (target.kind === "chunkFile") {
        const source = findVirtualSource(sources, target.sourceId);
        const chunk = await getVirtualFsChunk({
          teamId: this.input.teamId,
          workspaceId: this.input.workspaceId,
          sourceId: target.sourceId,
          chunkNo: target.chunkNo,
        });
        if (!chunk) {
          return { error: `ENOENT: no such chunk, grep '${path}'` };
        }
        appendRegexMatches({
          matches,
          regex,
          source,
          chunkNo: chunk.chunkNo,
          content: chunk.content,
          glob,
          globMatcher: matcher,
        });
        return { matches };
      }

      const sourceIds = target.kind === "sourceFile" || target.kind === "sourceDir" || target.kind === "chunksDir"
        ? [target.sourceId]
        : this.input.sourceIds;

      const targetSources = target.kind === "sourceFile" || target.kind === "sourceDir" || target.kind === "chunksDir"
        ? [findVirtualSource(sources, target.sourceId)]
        : sources;
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
            appendRegexMatches({
              matches,
              regex,
              source,
              chunkNo: chunk.chunkNo,
              content: chunk.content,
              glob,
              globMatcher: matcher,
            });
            if (matches.length >= MAX_GREP_RESULTS) {
              break;
            }
          }
          if (matches.length >= MAX_GREP_RESULTS) {
            break;
          }
        }
        return { matches };
      }

      const recallTerms = extractSearchTermsForRegex(pattern);
      if (recallTerms.length === 0) {
        return {
          error: `Regex pattern '${pattern}' has no literal terms for indexed recall, and the current /kb scope has ${fallbackChunkCount} chunks. Narrow grep to a specific /kb source or chunk path, select fewer sources, or include a literal term in the pattern.`,
        };
      }

      const candidates = await grepVirtualFsChunks({
        teamId: this.input.teamId,
        workspaceId: this.input.workspaceId,
        sourceIds,
        queryText: recallTerms.join(" "),
        topK: MAX_GREP_RECALL_TOP_K,
      });

      for (const candidate of candidates) {
        const source = sources.find((item) => item.sourceId === candidate.sourceId);
        if (!source) {
          continue;
        }
        appendRegexMatches({
          matches,
          regex,
          source,
          chunkNo: candidate.chunkNo,
          content: candidate.content,
          glob,
          globMatcher: matcher,
        });
        if (matches.length >= MAX_GREP_RESULTS) {
          break;
        }
      }
      return { matches };
    } catch (error) {
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
