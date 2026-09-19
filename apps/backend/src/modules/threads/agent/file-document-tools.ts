import { createHash, randomUUID } from "node:crypto";
import { tool } from "langchain";
import { z } from "zod";
import type { BackendProtocolV2 } from "deepagents";
import {
  fileRelativePathSchema,
  type FileSearchCoverage,
} from "@sourceweft/contracts";
import { ContentError } from "../../content/errors";
import { readFileDocument, type FileDocument } from "./file-documents";
import type { ScopedFileReader } from "./file-reader";
import { sanitizeNonCitableCitationMarkers } from "./fs-utils";
import type { AgentCitationRegistry } from "./citation-registry";

export function createFileDocumentTools(input: {
  read: ScopedFileReader;
  backend: Pick<BackendProtocolV2, "glob">;
  root: string;
  scopeId: string;
  signal?: AbortSignal;
  citationRegistry?: AgentCitationRegistry;
  nativeSearch?: (
    paths: string[],
    query: string,
    signal: AbortSignal,
  ) => Promise<{
    matchedPaths: string[];
    visitedPaths: string[];
    skipped: string[];
  }>;
}) {
  const cache = new Map<string, FileDocument>();
  let parsing = 0;
  const read = async (path: string, requestedSignal?: AbortSignal) => {
    const signal = AbortSignal.any([
      AbortSignal.timeout(120_000),
      ...[input.signal, requestedSignal].filter((value): value is AbortSignal =>
        Boolean(value),
      ),
    ]);
    const result = await input.read(path, signal);
    const key = `${result.file.fileId}:${result.file.revision}`;
    let document = cache.get(key);
    if (!document) {
      if (parsing >= 2)
        throw new ContentError(
          429,
          "FILE_READER_BUSY",
          "At most two documents can be parsed concurrently.",
        );
      parsing += 1;
      try {
        document = await readFileDocument(result.file, result.bytes, signal);
        signal.throwIfAborted();
        // This is turn-local reuse, not a Source index or an offline file copy.
        if (JSON.stringify(document).length <= 1024 * 1024) {
          if (cache.size >= 8) cache.delete(cache.keys().next().value!);
          cache.set(key, document);
        }
      } finally {
        parsing -= 1;
      }
    }
    return { file: result.file, document };
  };

  const readDocument = tool(
    async ({ path, cursor }) => {
      const { file, document } = await read(path);
      let unit = 0,
        offset = 0;
      if (cursor) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(
            Buffer.from(cursor, "base64url").toString("utf8"),
          );
        } catch {
          throw new ContentError(
            400,
            "INVALID_CURSOR",
            "Invalid document cursor.",
          );
        }
        const state = z
          .object({
            fileId: z.string(),
            revision: z.string(),
            unit: z.number().int().nonnegative(),
            offset: z.number().int().nonnegative(),
          })
          .strict()
          .parse(parsed);
        if (state.fileId !== file.fileId || state.revision !== file.revision)
          throw new ContentError(
            409,
            "FILE_CHANGED",
            "The document changed; start a new read.",
          );
        unit = state.unit;
        offset = state.offset;
      }
      if (
        unit > document.segments.length ||
        offset > (document.segments[unit]?.text.length ?? 0)
      )
        throw new ContentError(
          400,
          "INVALID_CURSOR",
          "Document cursor exceeds the available text.",
        );
      const segments: FileDocument["segments"] = [];
      const rawSegments: string[] = [];
      let remaining = 20_000;
      while (
        unit < document.segments.length &&
        segments.length < 50 &&
        remaining > 0
      ) {
        const segment = document.segments[unit]!;
        const length = Math.min(remaining, segment.text.length - offset);
        rawSegments.push(segment.text.slice(offset, offset + length));
        segments.push({
          locator: segment.locator,
          text: sanitizeNonCitableCitationMarkers(
            segment.text.slice(offset, offset + length),
          ),
        });
        remaining -= length;
        offset += length;
        if (offset >= segment.text.length) {
          unit += 1;
          offset = 0;
        }
      }
      const continuation =
        unit < document.segments.length
          ? Buffer.from(
              JSON.stringify({
                fileId: file.fileId,
                revision: file.revision,
                unit,
                offset,
              }),
            ).toString("base64url")
          : null;
      const citedSegments = segments.map((segment, index) => ({
        ...segment,
        citation:
          input.citationRegistry && rawSegments[index]?.trim()
            ? `[citation:${input.citationRegistry.addFile({ file, locator: segment.locator, content: rawSegments[index]!, origin: "read_document" }).citation}]`
            : undefined,
      }));
      return JSON.stringify({
        file,
        segments: citedSegments,
        continuation,
        warnings: document.warnings,
        coverage:
          continuation || document.warnings.length ? "partial" : "complete",
      });
    },
    {
      name: "read_document",
      description:
        "Read extractable text from a file in this conversation's Files, with page, slide, paragraph, line or spreadsheet cell locations. It does not add a Source or search Sources. Returns bounded text and a continuation cursor. Images are not OCRed; spreadsheet formulas are not executed.",
      schema: z.object({
        path: z.string().min(1),
        cursor: z.string().max(4096).optional(),
      }),
    },
  );

  type SearchState = {
    fingerprint: string;
    listing: string;
    offset: number;
    visited: number;
    matched: number;
    skipped: number;
    failed: number;
  };
  const cursors = new Map<string, SearchState>();
  const searchFiles = tool(
    async ({ query, directory, glob, cursor }) => {
      const started = Date.now();
      const literalPattern = Array.from(query, (character) =>
        "\\^$.*+?()[]{}|".includes(character) ? "\\" + character : character,
      ).join("");
      const expression = new RegExp(literalPattern, "iu");
      const deadline = AbortSignal.timeout(30_000);
      const root = input.root.replace(/\/+$/, "");
      const relative =
        directory === "." || directory === input.root
          ? ""
          : directory.startsWith(`${root}/`)
            ? directory.slice(root.length + 1)
            : directory;
      if (
        relative &&
        !fileRelativePathSchema.safeParse(relative.replace(/\/$/, "")).success
      )
        throw new ContentError(
          403,
          "FILE_SCOPE_DENIED",
          "Search a directory inside this conversation's Files.",
        );
      if (
        glob.startsWith("/") ||
        glob.split("/").includes("..") ||
        /[\x00-\x1f]/.test(glob)
      )
        throw new ContentError(
          400,
          "INVALID_GLOB",
          "Use a relative glob inside the selected directory.",
        );
      const path = relative
        ? `${root}/${relative.replace(/\/$/, "")}`
        : input.root;
      const listed = await input.backend.glob(glob, path);
      if (listed.error)
        throw new ContentError(409, "FILE_LIST_FAILED", String(listed.error));
      const files = (listed.files ?? [])
        .filter((file) => !file.is_dir)
        .sort((a, b) => a.path.localeCompare(b.path));
      const fingerprint = JSON.stringify([input.scopeId, path, glob, query]);
      const listing = createHash("sha256")
        .update(JSON.stringify(files.map((file) => file.path)))
        .digest("hex");
      const previous = cursor ? cursors.get(cursor) : undefined;
      if (
        cursor &&
        (!previous ||
          previous.fingerprint !== fingerprint ||
          previous.listing !== listing)
      )
        throw new ContentError(
          409,
          "SEARCH_SCOPE_CHANGED",
          "The search scope or file listing changed. Start a new search.",
        );
      const state: SearchState = previous
        ? { ...previous }
        : {
            fingerprint,
            listing,
            offset: 0,
            visited: 0,
            matched: 0,
            skipped: 0,
            failed: 0,
          };
      const hits: Array<{
        file: Awaited<ReturnType<ScopedFileReader>>["file"];
        locator: FileDocument["segments"][number]["locator"];
        text: string;
      }> = [];
      const warnings: Array<{ path: string; message: string }> = [];
      const initialOffset = state.offset;
      const nativePaths = input.nativeSearch
        ? files
            .slice(initialOffset, initialOffset + 100)
            .map((file) => file.path)
            .filter((path) => !/\.(pdf|docx|pptx|xlsx|csv)$/i.test(path))
        : [];
      const native = nativePaths.length
        ? await input.nativeSearch!(nativePaths, query, deadline)
        : null;
      const nativeCandidates = new Set(nativePaths);
      const nativeVisited = new Set(native?.visitedPaths);
      const nativeMatches = new Set(native?.matchedPaths);
      const nativeSkipped = new Set(native?.skipped);
      for (
        ;
        state.offset < files.length &&
        state.offset - initialOffset < 100 &&
        Date.now() - started < 30_000;
        state.offset += 1
      ) {
        input.signal?.throwIfAborted();
        const candidate = files[state.offset]!;
        state.visited += 1;
        if (native && nativeCandidates.has(candidate.path)) {
          if (!nativeVisited.has(candidate.path)) {
            state.visited -= 1;
            break;
          }
          if (nativeSkipped.has(candidate.path)) {
            state.skipped += 1;
            warnings.push({
              path: candidate.path,
              message: "Native text search could not inspect this file.",
            });
            continue;
          }
          if (!nativeMatches.has(candidate.path)) continue;
        }
        try {
          const { file, document } = await read(candidate.path, deadline);
          if (document.warnings.length) {
            state.skipped += 1;
            warnings.push({
              path: candidate.path,
              message: document.warnings.join(" "),
            });
          }
          const match = document.segments.find((segment) =>
            expression.test(segment.text),
          );
          if (match) {
            state.matched += 1;
            const index = expression.exec(match.text)!.index;
            hits.push({
              file,
              locator: match.locator,
              text: match.text.slice(
                Math.max(0, index - 160),
                index + query.length + 320,
              ),
            });
          }
        } catch (error) {
          if (input.signal?.aborted) throw error;
          if (deadline.aborted) {
            state.visited -= 1;
            break;
          }
          if (
            error instanceof ContentError &&
            [
              "DOCUMENT_UNSUPPORTED",
              "IMAGE_REQUIRED",
              "FILE_TOO_LARGE",
            ].includes(error.code)
          ) {
            state.skipped += 1;
            warnings.push({ path: candidate.path, message: error.message });
          } else if (
            error instanceof ContentError &&
            error.statusCode === 422
          ) {
            state.failed += 1;
            warnings.push({ path: candidate.path, message: error.message });
          } else throw error;
        }
      }
      const continuation = state.offset < files.length ? randomUUID() : null;
      if (continuation) cursors.set(continuation, state);
      const listingTruncated =
        "truncated" in listed && listed.truncated === true;
      const partial = Boolean(
        continuation || listingTruncated || state.skipped || state.failed,
      );
      const coverage: FileSearchCoverage = {
        status: partial ? "partial" : "complete",
        visited: state.visited,
        matched: state.matched,
        skipped: state.skipped,
        failed: state.failed,
        truncated: Boolean(continuation || listingTruncated),
        continuation,
      };
      const citedHits = hits.map((hit) => ({
        ...hit,
        text: sanitizeNonCitableCitationMarkers(hit.text),
        citation: input.citationRegistry
          ? `[citation:${input.citationRegistry.addFile({ file: hit.file, locator: hit.locator, content: hit.text, origin: "search_files" }).citation}]`
          : undefined,
      }));
      return JSON.stringify({
        scope: { directory: path, glob, query, totalCandidates: files.length },
        hits: citedHits,
        coverage,
        warnings,
        resultMode: "first_match_per_file",
      });
    },
    {
      name: "search_files",
      description:
        "Search literal text within this conversation's Files only. Uses the bound Local FS or Cloud VFS and document readers, never Source indexes or web search. Returns the first matching segment per file; use read_document for full context. Coverage and continuation report files or content not searched.",
      schema: z.object({
        query: z.string().min(1).max(500),
        directory: z.string().default("."),
        glob: z.string().max(4096).default("**/*"),
        cursor: z.string().max(256).optional(),
      }),
    },
  );

  return [readDocument, searchFiles] as const;
}
