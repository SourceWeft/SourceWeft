import { randomUUID } from "node:crypto";
import { ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { resolveBackend } from "deepagents";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import { InterpreterError, interpreterErrorCode } from "./errors";
import type {
  InterpreterEvent,
  InterpreterReadToolName,
  SourceWeftInterpreterOptions,
} from "./types";

const ALLOWED_ROOTS = ["/kb", "/workfiles"] as const;
const MAX_PATH_CHARS = 4_096;
const MAX_PATTERN_CHARS = 2_000;
const MAX_READ_LINES = 500;
const MAX_GREP_MATCHES = 200;

function emitSafely(
  sink: SourceWeftInterpreterOptions["eventSink"],
  event: InterpreterEvent,
) {
  if (!sink) return Promise.resolve();
  return Promise.resolve(sink(event)).catch(() => undefined);
}

function normalizedAbsolutePath(value: string) {
  if (
    !value.startsWith("/") ||
    value.length > MAX_PATH_CHARS ||
    value.includes("\0") ||
    value.includes("\\")
  ) {
    throw new InterpreterError("PATH_DENIED");
  }
  const components: string[] = [];
  for (const component of value.split("/")) {
    if (!component || component === ".") continue;
    if (component === ".." || component === "~") {
      throw new InterpreterError("PATH_DENIED");
    }
    components.push(component);
  }
  return `/${components.join("/")}` || "/";
}

function assertAllowedPath(value: string, rootAllowed = false) {
  const normalized = normalizedAbsolutePath(value);
  if (rootAllowed && normalized === "/") return normalized;
  if (
    !ALLOWED_ROOTS.some(
      (root) => normalized === root || normalized.startsWith(`${root}/`),
    )
  ) {
    throw new InterpreterError("PATH_DENIED");
  }
  return normalized;
}

function assertSafePattern(value: string) {
  if (
    value.length === 0 ||
    value.length > MAX_PATTERN_CHARS ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === ".." || part === "~")
  ) {
    throw new InterpreterError("PATH_DENIED");
  }
  if (value.startsWith("/")) {
    assertAllowedPath(value);
  }
  return value;
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (ToolMessage.isInstance(value)) {
    return typeof value.content === "string"
      ? value.content
      : JSON.stringify(value.content);
  }
  return JSON.stringify(value) ?? String(value);
}

async function requireSuccessfulResult<T extends { error?: string }>(
  result: T | Promise<T>,
) {
  const resolved = await result;
  if (resolved.error) throw new Error(resolved.error);
  return resolved;
}

function createPtcRunner(options: SourceWeftInterpreterOptions) {
  return async <T>(
    toolName: InterpreterReadToolName,
    operation: () => Promise<T>,
  ) => {
    const operationId = randomUUID();
    const startedAt = Date.now();
    await emitSafely(options.eventSink, {
      context: options.context,
      kind: "ptc",
      operationId,
      phase: "started",
      toolName,
    });
    try {
      const value = await options.gate.runPtc(
        options.context.turnId,
        operation,
      );
      const text = resultText(value);
      await emitSafely(options.eventSink, {
        context: options.context,
        durationMs: Date.now() - startedAt,
        kind: "ptc",
        operationId,
        phase: "completed",
        resultChars: text.length,
        toolName,
      });
      return value;
    } catch (error) {
      await emitSafely(options.eventSink, {
        context: options.context,
        durationMs: Date.now() - startedAt,
        errorCode: interpreterErrorCode(error),
        kind: "ptc",
        operationId,
        phase: "rejected",
        toolName,
      });
      throw error;
    }
  };
}

function searchSourcesPtcTool(
  original: StructuredToolInterface,
  run: ReturnType<typeof createPtcRunner>,
) {
  return tool(
    async ({ query }: { query: string }) =>
      run("search_sources", async () =>
        resultText(await original.invoke({ query })),
      ),
    {
      name: "search_sources",
      description:
        "Search only the sources visible to the current thread. Read-only.",
      schema: z.object({ query: z.string().min(1).max(MAX_PATTERN_CHARS) }),
    },
  );
}

export function createInterpreterReadTools(
  options: SourceWeftInterpreterOptions,
): StructuredToolInterface[] {
  const allowed = new Set(options.allowedTools);
  for (const name of allowed) {
    if (
      !(
        ["search_sources", "ls", "read_file", "glob", "grep"] as const
      ).includes(name)
    ) {
      throw new InterpreterError("TOOL_UNAVAILABLE");
    }
  }
  if (allowed.has("search_sources") && !options.searchSourcesTool) {
    throw new InterpreterError("TOOL_UNAVAILABLE");
  }

  const run = createPtcRunner(options);
  const tools: StructuredToolInterface[] = [];
  if (allowed.has("search_sources") && options.searchSourcesTool) {
    tools.push(searchSourcesPtcTool(options.searchSourcesTool, run));
  }
  if (allowed.has("ls")) {
    tools.push(
      tool(
        async ({ path }: { path?: string }, runtime: ToolRuntime) =>
          run("ls", async () => {
            const safePath = assertAllowedPath(path ?? "/", true);
            const backend = await resolveBackend(options.backend, runtime);
            const result = await requireSuccessfulResult(backend.ls(safePath));
            const files =
              safePath === "/"
                ? result.files?.filter((file) =>
                    ALLOWED_ROOTS.some(
                      (root) =>
                        file.path === root || file.path.startsWith(`${root}/`),
                    ),
                  )
                : result.files;
            return JSON.stringify({ ...result, files });
          }),
        {
          name: "ls",
          description:
            "List files under /kb or /workfiles. The root listing is filtered to those mounts.",
          schema: z.object({ path: z.string().optional().default("/") }),
        },
      ),
    );
  }
  if (allowed.has("read_file")) {
    tools.push(
      tool(
        async (
          input: { file_path: string; offset?: number; limit?: number },
          runtime: ToolRuntime,
        ) =>
          run("read_file", async () => {
            const filePath = assertAllowedPath(input.file_path);
            const offset = input.offset ?? 0;
            const limit = input.limit ?? MAX_READ_LINES;
            const backend = await resolveBackend(options.backend, runtime);
            const result = await requireSuccessfulResult(
              backend.read(filePath, offset, limit),
            );
            if (result.content instanceof Uint8Array) {
              throw new InterpreterError(
                "TOOL_UNAVAILABLE",
                "Binary file reads are unavailable in the interpreter.",
              );
            }
            return result.content ?? "";
          }),
        {
          name: "read_file",
          description: "Read a text file under /kb or /workfiles. Read-only.",
          schema: z.object({
            file_path: z.string(),
            offset: z.coerce.number().int().min(0).optional().default(0),
            limit: z.coerce
              .number()
              .int()
              .min(1)
              .max(MAX_READ_LINES)
              .optional()
              .default(MAX_READ_LINES),
          }),
        },
      ),
    );
  }
  if (allowed.has("glob")) {
    tools.push(
      tool(
        async (
          { pattern, path }: { pattern: string; path?: string },
          runtime: ToolRuntime,
        ) =>
          run("glob", async () => {
            const safePattern = assertSafePattern(pattern);
            const safePath = assertAllowedPath(path ?? "/", true);
            const backend = await resolveBackend(options.backend, runtime);
            const result = await requireSuccessfulResult(
              backend.glob(safePattern, safePath),
            );
            return JSON.stringify(result);
          }),
        {
          name: "glob",
          description: "Match files under /kb or /workfiles. Read-only.",
          schema: z.object({
            pattern: z.string().min(1).max(MAX_PATTERN_CHARS),
            path: z.string().optional(),
          }),
        },
      ),
    );
  }
  if (allowed.has("grep")) {
    tools.push(
      tool(
        async (
          input: {
            pattern: string;
            path?: string;
            glob?: string | null;
            max_count?: number | null;
          },
          runtime: ToolRuntime,
        ) =>
          run("grep", async () => {
            const safePath = assertAllowedPath(input.path ?? "/kb", true);
            const safeGlob = input.glob ? assertSafePattern(input.glob) : null;
            const backend = await resolveBackend(options.backend, runtime);
            const result = await requireSuccessfulResult(
              backend.grep(
                input.pattern,
                safePath,
                safeGlob,
                input.max_count ?? MAX_GREP_MATCHES,
              ),
            );
            return JSON.stringify(result);
          }),
        {
          name: "grep",
          description: "Search text under /kb or /workfiles. Read-only.",
          schema: z.object({
            pattern: z.string().min(1).max(MAX_PATTERN_CHARS),
            path: z.string().optional().default("/kb"),
            glob: z.string().nullable().optional().default(null),
            max_count: z.coerce
              .number()
              .int()
              .min(1)
              .max(MAX_GREP_MATCHES)
              .nullable()
              .optional()
              .default(MAX_GREP_MATCHES),
          }),
        },
      ),
    );
  }
  return tools;
}
