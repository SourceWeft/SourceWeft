import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AnyBackendProtocol } from "deepagents";

export const INTERPRETER_MAX_TOOL_NAMES = [
  "search_sources",
  "ls",
  "read_file",
  "glob",
  "grep",
] as const;

export type InterpreterReadToolName =
  (typeof INTERPRETER_MAX_TOOL_NAMES)[number];

export type InterpreterErrorCode =
  | "BUSY"
  | "EVAL_LIMIT"
  | "PTC_LIMIT"
  | "PTC_TIMEOUT"
  | "PATH_DENIED"
  | "TOOL_UNAVAILABLE"
  | "RUNTIME_TIMEOUT"
  | "RUNTIME_OOM";

export interface InterpreterLimits {
  executionTimeoutMs: number;
  memoryLimitBytes: number;
  maxStackSizeBytes: number;
  maxResultChars: number;
  maxPtcCallsPerEval: number;
  maxPtcCallsPerTurn: number;
  maxEvalsPerTurn: number;
  maxConcurrentEvals: number;
  maxConcurrentPtcPerTurn: number;
  evalQueueTimeoutMs: number;
  ptcCallTimeoutMs: number;
  maxCodeChars: number;
}

export const DEFAULT_INTERPRETER_LIMITS: Readonly<InterpreterLimits> = {
  executionTimeoutMs: 3_000,
  memoryLimitBytes: 32 * 1024 * 1024,
  maxStackSizeBytes: 320 * 1024,
  maxResultChars: 2_000,
  maxPtcCallsPerEval: 8,
  maxPtcCallsPerTurn: 24,
  maxEvalsPerTurn: 6,
  maxConcurrentEvals: 4,
  maxConcurrentPtcPerTurn: 4,
  evalQueueTimeoutMs: 1_000,
  ptcCallTimeoutMs: 5_000,
  maxCodeChars: 20_000,
};

export interface InterpreterEventContext {
  runId?: string | null;
  teamId?: string | null;
  threadId?: string | null;
  turnId: string;
  userId?: string | null;
  workspaceId?: string | null;
}

export type InterpreterEvent = {
  codeChars?: number;
  context: InterpreterEventContext;
  durationMs?: number;
  errorCode?: InterpreterErrorCode;
  kind: "eval" | "ptc";
  operationId: string;
  phase: "started" | "completed" | "rejected";
  resultChars?: number;
  toolName: string;
};

export type InterpreterEventSink = (
  event: InterpreterEvent,
) => void | Promise<void>;

export interface InterpreterExecutionGate {
  readonly limits: Readonly<InterpreterLimits>;
  acquireEval(turnKey: string): Promise<() => void>;
  runPtc<T>(turnKey: string, operation: () => Promise<T>): Promise<T>;
  resetTurn(turnKey: string): void;
}

export interface SourceWeftInterpreterOptions {
  backend: AnyBackendProtocol;
  allowedTools: readonly InterpreterReadToolName[];
  searchSourcesTool?: StructuredToolInterface;
  limits: Readonly<InterpreterLimits>;
  gate: InterpreterExecutionGate;
  eventSink?: InterpreterEventSink;
  context: InterpreterEventContext;
}
