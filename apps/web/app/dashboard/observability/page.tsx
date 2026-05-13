"use client";

import * as React from "react";
import {
  Activity,
  Boxes,
  ChevronDown,
  ChevronRight,
  Cpu,
  DatabaseZap,
  GitBranch,
  Loader2,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import { Badge } from "@sourceweft/ui-web/components/ui/badge";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { MessageResponse } from "@sourceweft/ui-web/components/ai-elements/message";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sourceweft/ui-web/components/ui/dropdown-menu";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import { ScrollArea } from "@sourceweft/ui-web/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@sourceweft/ui-web/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sourceweft/ui-web/components/ui/tabs";
import { cn } from "@sourceweft/ui-web/lib/utils";
import { llmObservabilityClient } from "../../../lib/sdk";
import { useDashboardChatState } from "../_components/dashboard-chat-state";
import type {
  LlmGenerationDetail,
  LlmObservationStatus,
  LlmSpanDetail,
  LlmTraceDetailResponse,
  LlmTraceSummary,
} from "@sourceweft/sdk";

const LIST_LIMIT = 50;
const ALL_WORKSPACES = "__all__";
const NOISY_MESSAGE_FIELDS = new Set([
  "additional_kwargs",
  "artifact",
  "id",
  "lc_direct_tool_output",
  "lc_kwargs",
  "response_metadata",
  "tool_call_id",
  "toolCallId",
]);

type TreeRow = {
  depth: number;
  id: string;
  node: SelectedNode;
  label: string;
  kind: string;
  status?: string;
  latencyMs?: number | null;
  startedAt?: string | null;
  icon: React.ComponentType<{ className?: string }>;
  parentId?: string | null;
  hasChildren?: boolean;
  defaultCollapsed?: boolean;
};

type SelectedNode =
  | { kind: "trace"; id: string }
  | { kind: "span"; id: string }
  | { kind: "generation"; id: string };

const statusFilters = ["all", "ok", "running", "error", "cancelled"] as const;
type StatusFilter = "all" | LlmObservationStatus;

function formatLatency(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "--";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

function formatTime(value: string | null | undefined) {
  if (!value) {
    return "--";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function statusClassName(status: string | null | undefined) {
  if (status === "error") {
    return "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300";
  }
  if (status === "running") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300";
  }
  if (status === "cancelled") {
    return "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300";
  }
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";
}

function statusReason(record: { errorMessage?: string | null; statusMessage?: string | null; errorCode?: string | null }) {
  return record.errorMessage ?? record.statusMessage ?? record.errorCode ?? null;
}

function ErrorMessageBlock({ children, compact = false }: { children: React.ReactNode; compact?: boolean }) {
  return (
    <div className={cn(
      "whitespace-pre-wrap break-words rounded-md border border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-200",
      compact ? "px-2 py-1 text-xs leading-5" : "px-3 py-2 text-xs leading-5",
    )}>
      {children}
    </div>
  );
}

function buildTree(detail: LlmTraceDetailResponse | null) {
  if (!detail) {
    return [] as TreeRow[];
  }

  const rows: TreeRow[] = [
    {
      depth: 0,
      id: detail.trace.traceId,
      node: { kind: "trace", id: detail.trace.traceId },
      label: detail.trace.name,
      kind: "trace",
      status: detail.trace.status,
      latencyMs: detail.trace.latencyMs,
      startedAt: detail.trace.startedAt,
      icon: GitBranch,
      parentId: null,
      hasChildren: true,
    },
  ];
  const spansByParent = new Map<string | null, LlmSpanDetail[]>();
  const generationsByParent = new Map<string | null, LlmGenerationDetail[]>();

  for (const span of detail.spans) {
    const key = span.parentSpanId ?? null;
    spansByParent.set(key, [...(spansByParent.get(key) ?? []), span]);
  }
  for (const generation of detail.generations) {
    const key = generation.parentSpanId ?? null;
    generationsByParent.set(key, [...(generationsByParent.get(key) ?? []), generation]);
  }

  const hasChildren = (spanId: string | null) =>
    Boolean(
      (spansByParent.get(spanId)?.length ?? 0) +
        (generationsByParent.get(spanId)?.length ?? 0),
    );

  const pushGeneration = (
    generation: LlmGenerationDetail,
    depth: number,
    parentId: string | null,
  ) => {
    const usage = generation.totalTokens
      ? `${generation.inputTokens ?? 0} -> ${generation.outputTokens ?? 0} tokens`
      : generation.operation;
    rows.push({
      depth,
      id: generation.id,
      node: { kind: "generation", id: generation.id },
      label: generation.name ?? generation.model ?? generation.operation,
      kind: usage,
      status: generation.status,
      latencyMs: generation.latencyMs,
      startedAt: generation.startedAt,
      icon: Cpu,
      parentId,
    });
  };

  const pushChildren = (parentSpanId: string | null, depth: number) => {
    const childSpans = spansByParent.get(parentSpanId) ?? [];
    const childGenerations = generationsByParent.get(parentSpanId) ?? [];
    const children = [
      ...childSpans.map((span) => ({ kind: "span" as const, startedAt: span.startedAt, span })),
      ...childGenerations.map((generation) => ({ kind: "generation" as const, startedAt: generation.startedAt, generation })),
    ].sort((left, right) => {
      const leftTime = left.startedAt ? new Date(left.startedAt).getTime() : 0;
      const rightTime = right.startedAt ? new Date(right.startedAt).getTime() : 0;
      return leftTime - rightTime;
    });

    for (const child of children) {
      if (child.kind === "generation") {
        pushGeneration(child.generation, depth, parentSpanId ?? detail.trace.traceId);
        continue;
      }
      const span = child.span;
      const spanHasChildren = hasChildren(span.spanId);
      rows.push({
        depth,
        id: span.spanId,
        node: { kind: "span", id: span.spanId },
        label: span.name,
        kind: span.kind,
        status: span.status,
        latencyMs: span.latencyMs,
        startedAt: span.startedAt,
        icon: span.kind === "tool" ? Boxes : span.kind === "retrieval" ? DatabaseZap : Activity,
        parentId: parentSpanId ?? detail.trace.traceId,
        hasChildren: spanHasChildren,
        defaultCollapsed: span.kind === "retrieval",
      });
      pushChildren(span.spanId, depth + 1);
    }
  };

  pushChildren(null, 1);
  return rows;
}

function traceMatchesNameFilter(trace: LlmTraceSummary, selectedNames: string[]) {
  return selectedNames.length === 0 || selectedNames.includes(trace.name);
}

function workspaceLabel(workspaces: Array<{ id: string; name: string }>, workspaceId: string | null | undefined) {
  if (!workspaceId) return "--";
  return workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? workspaceId;
}

function sessionLabel(trace: Pick<LlmTraceSummary, "sessionId" | "threadId">) {
  return trace.sessionId ?? trace.threadId ?? "--";
}

function traceSelectionKey(traceId: string, workspaceId?: string | null) {
  return `${workspaceId ?? ""}:${traceId}`;
}

function unwrapPayload(value: unknown) {
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record.redacted === true) {
    return value;
  }
  if (record.mode === "full" && "value" in record) {
    return record.value;
  }
  if (record.mode === "preview" && "preview" in record) {
    return record.preview;
  }
  if (typeof record.preview === "string") {
    return record.preview;
  }
  return value;
}

function parsePolicyPayload(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function payloadPreview(value: unknown) {
  const unwrapped = parseMaybeJson(unwrapPayload(value));
  if (unwrapped === null || unwrapped === undefined || unwrapped === "") {
    return "--";
  }
  if (typeof unwrapped === "string") {
    return unwrapped;
  }
  return JSON.stringify(unwrapped, null, 2);
}

function isEmptyPayload(value: unknown) {
  const unwrapped = unwrapDeepPayload(value);
  if (unwrapped === null || unwrapped === undefined || unwrapped === "" || unwrapped === "[Circular]") return true;
  if (typeof unwrapped === "object" && !Array.isArray(unwrapped)) {
    const record = unwrapped as Record<string, unknown>;
    if (record.redacted === true) return false;
    return Object.keys(record).length === 0;
  }
  return false;
}

function usefulContent(...values: unknown[]) {
  return values.find((value) => !isEmptyPayload(value));
}

function compactPayloadPreview(value: unknown, maxLength = 180) {
  const preview = payloadPreview(value).replace(/\s+/g, " ").trim();
  if (preview.length <= maxLength) return preview;
  return `${preview.slice(0, maxLength - 3)}...`;
}

function toRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function metadataEntries(value: unknown) {
  const record = toRecord(unwrapDeepPayload(value));
  if (!record) return [] as Array<[string, unknown]>;
  return Object.entries(record).filter(([, entryValue]) => !isEmptyPayload(entryValue));
}

function hasUsefulPayload(value: unknown) {
  return metadataEntries(value).length > 0;
}

function extractMessages(value: unknown) {
  const unwrapped = unwrapDeepPayload(value);
  if (Array.isArray(unwrapped)) return unwrapped;
  const record = toRecord(unwrapped);
  if (Array.isArray(record?.messages)) return record.messages;
  if (Array.isArray(record?.input) && record.input.some(isMessageLike)) return record.input;
  if (Array.isArray(record?.output) && record.output.some(isMessageLike)) return record.output;
  if (typeof record?.message === "string") return [{ role: "user", content: record.message }];
  if (isMessageLike(record)) return [record];
  return [];
}

function isMessageLike(value: unknown) {
  const record = toRecord(value);
  if (!record) return false;
  return "role" in record || "content" in record || "tool_call_id" in record || "toolCallId" in record || "lc_kwargs" in record;
}

function isMessagesContainer(value: unknown) {
  const record = toRecord(unwrapDeepPayload(value));
  return Boolean(record && Array.isArray(record.messages) && record.messages.some(isMessageLike));
}

function extractMessageEnvelope(value: unknown) {
  const parsed = unwrapDeepPayload(value);
  if (Array.isArray(parsed) && parsed.some(isMessageLike)) {
    return {
      messages: parsed,
      metadata: {} as Record<string, unknown>,
    };
  }
  const record = toRecord(parsed);
  if (!record) return null;
  if (Array.isArray(record.messages) && record.messages.some(isMessageLike)) {
    return {
      messages: record.messages,
      metadata: Object.fromEntries(
        Object.entries(record).filter(([key, entryValue]) => key !== "messages" && !isEmptyPayload(entryValue)),
      ),
    };
  }
  if (Array.isArray(record.input) && record.input.some(isMessageLike)) {
    return {
      messages: record.input,
      metadata: Object.fromEntries(
        Object.entries(record).filter(([key, entryValue]) => key !== "input" && !isEmptyPayload(entryValue)),
      ),
    };
  }
  if (Array.isArray(record.output) && record.output.some(isMessageLike)) {
    return {
      messages: record.output,
      metadata: Object.fromEntries(
        Object.entries(record).filter(([key, entryValue]) => key !== "output" && !isEmptyPayload(entryValue)),
      ),
    };
  }
  return null;
}

function extractToolCalls(value: unknown) {
  const record = toRecord(unwrapDeepPayload(value));
  if (!record) return [];
  for (const key of ["toolCalls", "tool_calls", "tools"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

function extractMessageToolCalls(record: Record<string, unknown> | null) {
  if (!record) return [];
  for (const key of ["toolCalls", "tool_calls"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

function extractUsage(value: unknown) {
  const record = toRecord(unwrapDeepPayload(value));
  return toRecord(record?.usage);
}

function extractReasoning(value: unknown) {
  const record = toRecord(unwrapDeepPayload(value));
  if (!record) return null;
  return record.reasoning ?? record.reasoningText ?? record.reasoningSummary ?? null;
}

function extractReasoningSegments(value: unknown) {
  const record = toRecord(unwrapDeepPayload(value));
  if (!record || !Array.isArray(record.reasoningSegments)) {
    return [];
  }
  return record.reasoningSegments;
}

function omitRecordKeys(value: unknown, keys: string[]) {
  const record = toRecord(unwrapDeepPayload(value));
  if (!record) return value;
  const omitted = new Set(keys);
  const next = Object.fromEntries(
    Object.entries(record).filter(([key]) => !omitted.has(key)),
  );
  return Object.keys(next).length > 0 ? next : null;
}

function parseMaybeJson(value: unknown) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0] ?? "")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function extractJsonStringField(value: string, field: string) {
  const key = `"${field}"`;
  const keyIndex = value.indexOf(key);
  if (keyIndex < 0) return null;
  const colonIndex = value.indexOf(":", keyIndex + key.length);
  if (colonIndex < 0) return null;
  let index = colonIndex + 1;
  while (index < value.length && /\s/.test(value[index] ?? "")) index += 1;
  if (value[index] !== '"') return null;
  index += 1;
  let output = "";
  let escaped = false;
  for (; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (escaped) {
      output += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      try {
        return JSON.parse(`"${output}"`) as string;
      } catch {
        return output;
      }
    }
    output += char;
  }
  try {
    return JSON.parse(`"${output}"`) as string;
  } catch {
    return output.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
}

function partialStructuredStringView(value: unknown) {
  const unwrapped = unwrapPayload(value);
  if (typeof unwrapped !== "string") return null;
  const trimmed = unwrapped.trim();
  if (!trimmed.startsWith("{")) return null;
  const content = extractJsonStringField(trimmed, "content")
    ?? extractJsonStringField(trimmed, "assistantContent")
    ?? extractJsonStringField(trimmed, "outputText");
  if (!content) return null;
  const metadata: Record<string, unknown> = {};
  const citationCount = trimmed.match(/"citationCount"\s*:\s*(\d+)/)?.[1];
  if (citationCount) metadata.citationCount = Number(citationCount);
  const finishReason = extractJsonStringField(trimmed, "finishReason");
  if (finishReason) metadata.finishReason = finishReason;
  const reasoning = extractJsonStringField(trimmed, "reasoning");
  if (reasoning) metadata.reasoning = reasoning;
  return <PrimaryContentView content={content} metadata={metadata} />;
}

function unwrapDeepPayload(value: unknown): unknown {
  let current = value;
  for (let index = 0; index < 4; index += 1) {
    const next = parseMaybeJson(unwrapPayload(parsePolicyPayload(current)));
    if (next === current) return next;
    current = next;
  }
  return current;
}

function normalizeMessageRole(record: Record<string, unknown> | null, fallbackRole: string) {
  const explicitRole = record?.role ?? record?.type ?? record?._getType;
  if (typeof explicitRole === "string") {
    const lowerRole = explicitRole.toLowerCase();
    if (lowerRole.includes("tool")) return "tool";
    if (lowerRole.includes("system")) return "system";
    if (lowerRole.includes("assistant") || lowerRole.includes("ai")) return "assistant";
    if (lowerRole.includes("human") || lowerRole.includes("user")) return "user";
    return explicitRole;
  }
  if (record && ("tool_call_id" in record || "toolCallId" in record || "lc_direct_tool_output" in record)) return "tool";
  return fallbackRole;
}

function normalizeMessageContent(message: unknown): unknown {
  const unwrapped = unwrapDeepPayload(message);
  const record = toRecord(unwrapped);
  const kwargs = toRecord(record?.lc_kwargs);
  const content = record?.content ?? kwargs?.content;
  if (typeof content === "string") return parseMaybeJson(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const partRecord = toRecord(part);
        return typeof partRecord?.text === "string" ? partRecord.text : payloadPreview(part);
      })
      .join("\n");
  }
  if (typeof unwrapped === "string") return parseMaybeJson(unwrapped);
  if (record) {
    const usefulEntries = Object.fromEntries(
      Object.entries(record).filter(([key, entryValue]) => !NOISY_MESSAGE_FIELDS.has(key) && entryValue !== undefined && entryValue !== null),
    );
    if (Object.keys(usefulEntries).length > 0) return usefulEntries;
  }
  return payloadPreview(unwrapped);
}

function messageRoleClassName(role: string) {
  const normalized = role.toLowerCase();
  if (normalized === "system") {
    return "text-slate-600 dark:text-slate-300";
  }
  if (normalized === "assistant") {
    return "text-sky-700 dark:text-sky-300";
  }
  if (normalized === "tool") {
    return "text-amber-700 dark:text-amber-300";
  }
  return "text-emerald-700 dark:text-emerald-300";
}

function messageRoleLabel(role: string) {
  const normalized = role.toLowerCase();
  if (normalized === "system") return "System";
  if (normalized === "assistant") return "Assistant";
  if (normalized === "tool") return "Tool";
  if (normalized === "user") return "User";
  return role;
}

function MessageEnvelopeSummary({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata).filter(([, value]) => !isEmptyPayload(value));
  if (entries.length === 0) return null;
  const preferred = ["messageCount", "toolCount", "stream", "operation", "model"];
  const orderedEntries = [
    ...preferred
      .filter((key) => Object.prototype.hasOwnProperty.call(metadata, key) && !isEmptyPayload(metadata[key]))
      .map((key) => [key, metadata[key]] as [string, unknown]),
    ...entries.filter(([key]) => !preferred.includes(key)),
  ];
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 text-xs text-muted-foreground">
      {orderedEntries.map(([key, value], index) => {
        const label = compactPayloadPreview(value, 72);
        return (
          <span
            className="inline-flex min-w-0 max-w-full items-center gap-1.5"
            key={key}
            title={`${key}: ${label}`}
          >
            {index > 0 ? <span className="text-border">/</span> : null}
            <span>{key}</span>
            <span className="min-w-0 truncate font-mono">{label}</span>
          </span>
        );
      })}
    </div>
  );
}

function MessageToolCallSummary({ calls }: { calls: unknown[] }) {
  if (calls.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      <span>Tool calls:</span>
      {calls.map((call, index) => {
        const record = toRecord(call) ?? {};
        const fn = toRecord(record.function);
        const name = record.name ?? record.tool ?? record.toolName ?? fn?.name ?? `tool_${index + 1}`;
        const id = record.id ?? record.toolCallId ?? record.tool_call_id;
        return (
          <span
            className="inline-flex max-w-full items-center gap-1 font-mono"
            key={`${index}:${String(id ?? name)}`}
          >
            <Wrench className="h-3 w-3 shrink-0" />
            <span className="truncate">{String(name)}</span>
            {id ? <span className="truncate opacity-70">{String(id)}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

function normalizeToolArgs(value: unknown) {
  const parsed = unwrapDeepPayload(value);
  const record = toRecord(parsed);
  return record ?? { value: parsed };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
}

function PreviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h4 className="px-2 text-sm font-medium text-foreground">{title}</h4>
      <div className="rounded-md px-2 py-1 text-sm leading-6 text-foreground">
        {children}
      </div>
    </section>
  );
}

function EmptySection({ label = "No data recorded." }: { label?: string }) {
  return <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">{label}</div>;
}

function DashValue() {
  return <span className="text-muted-foreground">--</span>;
}

function TextValue({ value }: { value: string }) {
  const isLong = value.length > 900 || value.split("\n").length > 14;
  if (!isLong) {
    return <div className="whitespace-pre-wrap break-words leading-6">{value}</div>;
  }
  const preview = value.replace(/\s+/g, " ").trim().slice(0, 360);
  return (
    <details className="group rounded-md border border-border bg-background" open={false}>
      <summary className="cursor-pointer list-none border-b border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40">
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate">{preview}{value.length > 360 ? "..." : ""}</span>
          <span className="shrink-0 font-medium text-foreground group-open:hidden">Show full text</span>
          <span className="hidden shrink-0 font-medium text-foreground group-open:inline">Hide full text</span>
        </div>
      </summary>
      <div className="max-h-[520px] overflow-auto p-3">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">{value}</pre>
      </div>
    </details>
  );
}

function MarkdownValue({ value }: { value: string }) {
  const isLong = value.length > 6000;
  if (!isLong) {
    return (
      <div className="max-w-none text-sm leading-6 text-foreground [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3">
        <MessageResponse>{value}</MessageResponse>
      </div>
    );
  }
  return (
    <details className="group rounded-lg border border-border bg-background" open>
      <summary className="cursor-pointer list-none border-b border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40">
        <div className="flex items-center justify-between gap-3">
          <span>Long markdown output ({value.length.toLocaleString()} chars)</span>
          <span className="font-medium text-foreground group-open:hidden">Show</span>
          <span className="hidden font-medium text-foreground group-open:inline">Hide</span>
        </div>
      </summary>
      <div className="max-h-[680px] overflow-auto p-4 text-sm leading-6 text-foreground [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3">
        <MessageResponse>{value}</MessageResponse>
      </div>
    </details>
  );
}

function DisplayValue({ value, markdown = false }: { value: unknown; markdown?: boolean }) {
  const parsed = unwrapDeepPayload(value);
  if (parsed === null || parsed === undefined || parsed === "") return <DashValue />;
  if (parsed && typeof parsed === "object") return <JsonValueTable value={parsed} />;
  if (typeof parsed === "string" && markdown) return <MarkdownValue value={parsed} />;
  return <PrimitiveValue value={parsed} />;
}

function MessageTextValue({ value }: { value: string }) {
  const isLong = value.length > 900 || value.split("\n").length > 14;
  if (!isLong) {
    return (
      <div className="max-w-none whitespace-pre-wrap break-words text-sm leading-6 text-foreground [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-auto [&_pre]:rounded-sm [&_pre]:bg-muted/40 [&_pre]:p-2">
        <MessageResponse>{value}</MessageResponse>
      </div>
    );
  }
  const preview = value.replace(/\s+/g, " ").trim().slice(0, 320);
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-xs leading-5 text-muted-foreground hover:text-foreground">
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate">{preview}{value.length > 320 ? "..." : ""}</span>
          <span className="shrink-0 font-medium text-foreground group-open:hidden">Show full text</span>
          <span className="hidden shrink-0 font-medium text-foreground group-open:inline">Hide full text</span>
        </div>
      </summary>
      <div className="mt-2 max-h-[520px] overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-foreground [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-auto [&_pre]:rounded-sm [&_pre]:bg-muted/40 [&_pre]:p-2">
        <MessageResponse>{value}</MessageResponse>
      </div>
    </details>
  );
}

function MessageContentValue({ value }: { value: unknown }) {
  const parsed = unwrapDeepPayload(value);
  if (parsed === null || parsed === undefined || parsed === "") return <DashValue />;
  if (typeof parsed === "string") return <MessageTextValue value={parsed} />;
  if (parsed && typeof parsed === "object") {
    return (
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-sm bg-muted/20 px-2 py-1.5 font-mono text-xs leading-5 text-foreground">
        {JSON.stringify(parsed, null, 2)}
      </pre>
    );
  }
  return <PrimitiveValue value={parsed} />;
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <DashValue />;
  }
  if (value === "[Circular]") return <DashValue />;
  if (typeof value === "boolean") {
    return <Badge variant="secondary">{value ? "true" : "false"}</Badge>;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return <span className="font-mono text-xs">{String(value)}</span>;
  }
  if (value === "[REDACTED]") return <RedactedValueNotice />;
  return <TextValue value={String(value)} />;
}

function isCompactArrayValue(value: unknown) {
  return value === null || ["string", "number", "boolean", "bigint"].includes(typeof value);
}

function compactArrayLabel(value: unknown) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function CompactArrayValue({ values }: { values: unknown[] }) {
  return (
    <div className="flex max-h-40 min-w-0 flex-wrap gap-1.5 overflow-y-auto py-0.5">
      {values.map((item, index) => {
        const label = compactArrayLabel(item);
        return (
          <span
            className="min-w-0 max-w-full rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[11px] leading-5 text-foreground"
            key={`${index}:${label}`}
            title={label}
          >
            <span className="break-all">{label}</span>
          </span>
        );
      })}
    </div>
  );
}

function JsonValueTable({ value, depth = 0, keepEmpty = false }: { value: unknown; depth?: number; keepEmpty?: boolean }) {
  const parsed = unwrapDeepPayload(value);
  const redacted = isRedactedPayload(parsed);
  if (redacted) return <RedactionNotice value={parsed} />;
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return <DashValue />;
    if (parsed.every(isCompactArrayValue)) {
      return <CompactArrayValue values={parsed} />;
    }
    const entries = parsed
      .map((entryValue, index) => ({ entryValue, index }))
      .filter(({ entryValue }) => keepEmpty || !isEmptyPayload(entryValue));
    if (entries.length === 0) return <DashValue />;
    return (
      <div className={cn("min-w-0 overflow-hidden rounded-md text-sm", depth === 0 && "border border-border", depth > 0 && "bg-muted/10")}> 
        {entries.map(({ entryValue, index }) => (
          <div className={cn("border-b border-border/60 last:border-b-0", depth === 0 && "grid grid-cols-[88px_minmax(0,1fr)]")} key={index}>
            <div className="bg-muted/20 px-2 py-1.5 font-mono text-xs text-muted-foreground">[{index}]</div>
            <div className="min-w-0 overflow-x-auto px-2 py-1.5 text-foreground">
              <JsonValueTable depth={depth + 1} keepEmpty={keepEmpty} value={entryValue} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  const record = toRecord(parsed);
  if (record) {
    const entries = Object.entries(record).filter(([, entryValue]) => keepEmpty || !isEmptyPayload(entryValue));
    if (entries.length === 0) return <DashValue />;
    return (
      <div className={cn("min-w-0 overflow-hidden rounded-md text-sm", depth === 0 && "border border-border", depth > 0 && "bg-muted/10")}> 
        {entries.map(([key, entryValue]) => {
          const nested = unwrapDeepPayload(entryValue);
          const isNested = Boolean(nested && typeof nested === "object");
          return (
            <div className={cn("border-b border-border/60 last:border-b-0", depth === 0 && "grid grid-cols-[160px_minmax(0,1fr)]")} key={key}>
              <div className="flex min-w-0 items-center gap-2 bg-muted/20 px-2 py-1.5 font-medium text-muted-foreground">
                {isNested ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <span className="w-3.5 shrink-0" />}
                <span className="truncate">{key}</span>
              </div>
              <div className="min-w-0 overflow-x-auto px-2 py-1.5 text-foreground">
                {isNested ? <JsonValueTable depth={depth + 1} keepEmpty={keepEmpty} value={nested} /> : <PrimitiveValue value={nested} />}
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  return <PrimitiveValue value={parsed} />;
}

function KeyValueTable({ value }: { value: unknown }) {
  const entries = metadataEntries(value);
  if (entries.length === 0) return <DashValue />;
  return (
    <div className="overflow-hidden rounded-md border border-border text-sm">
      {entries.map(([key, entryValue]) => (
        <div className="grid grid-cols-[160px_minmax(0,1fr)] border-b border-border/60 last:border-b-0" key={key}>
          <div className="bg-muted/20 px-2 py-1.5 font-medium text-muted-foreground">{key}</div>
          <div className="min-w-0 px-2 py-1.5 text-foreground">
            <JsonValueTable value={entryValue} />
          </div>
        </div>
      ))}
    </div>
  );
}

function PrimaryContentView({
  content,
  metadata,
}: {
  content: unknown;
  metadata?: Record<string, unknown>;
}) {
  const metadataEntries = metadata
    ? Object.entries(metadata).filter(([, entryValue]) => !isEmptyPayload(entryValue))
    : [];
  const toolCalls = Array.isArray(metadata?.toolCalls) ? metadata.toolCalls : [];
  const otherMetadata = Object.fromEntries(
    metadataEntries.filter(([key]) => key !== "toolCalls" && key !== "content"),
  );
  return (
    <div className="space-y-3">
      <DisplayValue markdown value={content} />
      {toolCalls.length > 0 ? (
        <div className="border-t border-border/60 pt-3">
          <ToolCallList value={toolCalls} />
        </div>
      ) : null}
      {Object.keys(otherMetadata).length > 0 ? (
        <div className="border-t border-border/60 pt-3">
          <KeyValueTable value={otherMetadata} />
        </div>
      ) : null}
    </div>
  );
}

function structuredRecordView(value: unknown) {
  const record = toRecord(unwrapDeepPayload(value));
  if (!record) return null;
  const primaryKey = ["content", "message", "assistantContent", "outputText"].find(
    (key) => !isEmptyPayload(record[key]),
  );
  if (!primaryKey) return null;
  const metadata = Object.fromEntries(
    Object.entries(record).filter(([key, entryValue]) => key !== primaryKey && !isEmptyPayload(entryValue)),
  );
  return <PrimaryContentView content={record[primaryKey]} metadata={metadata} />;
}

function ToolCallList({ value }: { value: unknown }) {
  const calls = Array.isArray(value) ? value : extractToolCalls(value);
  if (calls.length === 0) return <EmptySection label="No tool calls." />;
  return (
    <div className="space-y-2">
      {calls.map((call, index) => {
        const record = toRecord(call) ?? {};
        const functionRecord = toRecord(record.function);
        const name = record.tool ?? record.toolName ?? record.name ?? functionRecord?.name ?? `tool_${index + 1}`;
        const args = record.input ?? record.args ?? record.arguments ?? functionRecord?.arguments ?? record.tool_input;
        const rawOutput = record.output ?? record.result;
        const toolMessage = normalizeToolMessage(rawOutput);
        const output = toolMessage?.content ?? rawOutput;
        return (
          <div className="rounded-lg border border-border bg-background" key={index}>
            <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
              <Wrench className="h-3.5 w-3.5" />
              {String(name)}
            </div>
            {args !== undefined ? <div className="p-3"><KeyValueTable value={normalizeToolArgs(args)} /></div> : null}
            {output !== undefined ? <div className="border-t border-border p-3"><JsonValueTable value={output} /></div> : null}
          </div>
        );
      })}
    </div>
  );
}

function ReasoningView({
  reasoning,
  segments,
}: {
  reasoning: unknown;
  segments?: unknown[];
}) {
  if (segments?.length) {
    return (
      <div className="space-y-2">
        {segments.map((segment, index) => {
          const record = toRecord(segment);
          const text = record?.text ?? segment;
          const phase = typeof record?.phase === "string" ? record.phase : "initial";
          const tool = record?.tool ?? record?.toolName;
          const toolCallId = record?.toolCallId ?? record?.tool_call_id;
          const durationMs =
            typeof record?.durationMs === "number" ? record.durationMs : null;
          return (
            <article className="overflow-hidden rounded-lg border border-border bg-background" key={String(record?.id ?? index)}>
              <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                <Badge variant="secondary">#{index + 1}</Badge>
                <span className="font-medium text-foreground">
                  {phase === "after_tool" ? "After tool" : "Before tool"}
                </span>
                {tool ? (
                  <span className="inline-flex min-w-0 items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px]">
                    <Wrench className="h-3 w-3 shrink-0" />
                    <span className="truncate">{String(tool)}</span>
                  </span>
                ) : null}
                {toolCallId ? (
                  <span className="max-w-full truncate font-mono text-[11px] opacity-70">
                    {String(toolCallId)}
                  </span>
                ) : null}
                {durationMs !== null ? (
                  <span className="ml-auto shrink-0 font-mono text-[11px]">
                    {formatLatency(durationMs)}
                  </span>
                ) : null}
              </div>
              <div className="p-3 text-sm leading-6 text-foreground">
                <DisplayValue value={text} />
              </div>
            </article>
          );
        })}
      </div>
    );
  }

  return <StructuredValue value={reasoning} />;
}

function normalizeToolMessage(value: unknown) {
  const unwrapped = unwrapDeepPayload(value);
  const record = toRecord(unwrapped);
  if (!record) return null;
  const kwargs = toRecord(record.lc_kwargs) ?? toRecord(record.kwargs);
  const content = usefulContent(record.content, kwargs?.content);
  const name = record.name ?? kwargs?.name ?? record.toolName ?? record.tool ?? record.tool_name;
  const id = record.tool_call_id ?? record.toolCallId ?? record.id;
  const isToolLike = record.lc_direct_tool_output === true || record.type === "tool" || record._getType === "tool" || id !== undefined;
  if (!isToolLike && content === undefined && name === undefined) return null;
  return { content, name, id };
}

function RedactionNotice({ value }: { value: unknown }) {
  const unwrapped = unwrapPayload(value);
  if (!unwrapped || typeof unwrapped !== "object" || !("redacted" in unwrapped)) return null;
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/20 p-3 text-sm text-muted-foreground">
      Payload hidden by observability access policy: {(unwrapped as { reason?: string }).reason ?? "redacted"}
    </div>
  );
}

function RedactedValueNotice() {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title="Sensitive value removed before storage">
      redacted sensitive value
    </span>
  );
}

function isRedactedPayload(value: unknown) {
  const unwrapped = unwrapDeepPayload(value);
  return Boolean(unwrapped && typeof unwrapped === "object" && "redacted" in unwrapped);
}

function StructuredValue({
  value,
  fallbackRole = "user",
  unwrapToolOutput = false,
}: {
  value: unknown;
  fallbackRole?: string;
  unwrapToolOutput?: boolean;
}) {
  if (value === null || value === undefined || value === "") return <DashValue />;
  if (isRedactedPayload(value)) return <RedactionNotice value={value} />;
  const partialStringView = partialStructuredStringView(value);
  if (partialStringView) return partialStringView;
  if (isMessagesContainer(value)) return <MessageList fallbackRole={fallbackRole} value={value} />;
  const toolMessage = normalizeToolMessage(value);
  if (toolMessage && unwrapToolOutput) {
    return <DisplayValue markdown value={toolMessage.content} />;
  }
  if (toolMessage) {
    return (
      <article className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
          <Wrench className="h-3.5 w-3.5" />
          {toolMessage.name ? String(toolMessage.name) : "tool result"}
          {toolMessage.id ? <span className="truncate opacity-70">{String(toolMessage.id)}</span> : null}
        </div>
        <div className="p-3 text-sm leading-6 text-foreground">
          <DisplayValue markdown value={toolMessage.content} />
        </div>
      </article>
    );
  }
  const recordView = structuredRecordView(value);
  if (recordView) return recordView;
  if (typeof unwrapDeepPayload(value) === "string") return <DisplayValue markdown value={value} />;
  const record = toRecord(unwrapDeepPayload(value));
  if (record && ("input" in record || "output" in record) && extractMessages(value).some(isMessageLike)) {
    return <MessageList fallbackRole={fallbackRole} value={value} />;
  }
  if (record && ("path" in record || "query" in record || "pattern" in record || "glob" in record)) {
    return <KeyValueTable value={record} />;
  }
  return <JsonValueTable value={value} />;
}

function MessageList({ value, fallbackRole = "user" }: { value: unknown; fallbackRole?: string }) {
  const envelope = extractMessageEnvelope(value);
  const messages = envelope?.messages ?? extractMessages(value);
  if (messages.length === 0) {
    const parsed = parseMaybeJson(unwrapPayload(value));
    if (isEmptyPayload(parsed)) return <DashValue />;
    return <div className="text-sm leading-6 text-foreground"><DisplayValue markdown value={parsed} /></div>;
  }
  return (
    <div className="space-y-1">
      {envelope ? <MessageEnvelopeSummary metadata={envelope.metadata} /> : null}
      <div className="divide-y divide-border/50">
        {messages.map((message, index) => {
          const record = toRecord(message);
          const role = normalizeMessageRole(record, fallbackRole);
          const content = normalizeMessageContent(message);
          const toolCalls = extractMessageToolCalls(record);
          const parsedContent = parseMaybeJson(content);
          const toolCallId = record?.toolCallId ?? record?.tool_call_id;
          const contentLength =
            typeof content === "string"
              ? content.length
                : typeof toRecord(content)?.length === "number"
                  ? Number(toRecord(content)?.length)
                  : null;
          return (
            <article className="grid grid-cols-[86px_minmax(0,1fr)] gap-4 py-3 max-sm:grid-cols-1 max-sm:gap-1" key={index}>
              <div className="min-w-0 px-1 text-[11px] leading-5 text-muted-foreground">
                <div className={cn("truncate font-semibold", messageRoleClassName(role))}>
                  {messageRoleLabel(role)}
                </div>
                <div className="font-mono">#{index + 1}</div>
              </div>
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  {toolCallId ? (
                    <span className="min-w-0 truncate font-mono">
                      toolCallId: {String(toolCallId)}
                    </span>
                  ) : null}
                  {toolCalls.length > 0 ? (
                    <span>
                      {toolCalls.length} tool call{toolCalls.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  {contentLength !== null ? (
                    <span className="ml-auto shrink-0 font-mono max-sm:ml-0">
                      {contentLength.toLocaleString()} chars
                    </span>
                  ) : null}
                </div>
                <MessageContentValue value={parsedContent} />
                <MessageToolCallSummary calls={toolCalls} />
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <div className="max-h-[520px] overflow-auto rounded-lg bg-background text-sm">
      <JsonValueTable keepEmpty value={value} />
    </div>
  );
}

function selectedNodeData(detail: LlmTraceDetailResponse | null, selected: SelectedNode | null) {
  if (!detail || !selected) {
    return null;
  }
  if (selected.kind === "trace") {
    const metadata = detail.trace.metadata ?? {};
    const agentRun = detail.spans.find((item) => item.spanId === "agent_run");
    const finalGeneration = [...detail.generations]
      .reverse()
      .find((generation) => generation.outputText || generation.output);
    const fallbackOutput = agentRun?.output ?? finalGeneration?.outputText ?? finalGeneration?.output;
    return {
      kind: "trace",
      title: detail.trace.name,
      status: detail.trace.status,
      errorMessage: detail.trace.errorMessage,
      statusMessage: detail.trace.statusMessage,
      latencyMs: detail.trace.latencyMs,
      startedAt: detail.trace.startedAt,
      input: detail.trace.input,
      reasoning: extractReasoning(detail.trace.output),
      reasoningSegments: extractReasoningSegments(detail.trace.output),
      output: isEmptyPayload(detail.trace.output) ? fallbackOutput : detail.trace.output,
      metrics: {
        durationMs: detail.trace.durationMs ?? detail.trace.latencyMs,
        observationCount: detail.trace.observationCount ?? detail.spans.length + detail.generations.length,
        totalTokens: detail.trace.totalTokens ?? detail.generations.reduce((sum, generation) => sum + (generation.totalTokens ?? 0), 0),
      },
      parameters: {},
      metadata,
      raw: detail.trace,
    };
  }
  if (selected.kind === "span") {
    const span = detail.spans.find((item) => item.spanId === selected.id);
    if (!span) return null;
    return {
      kind: span.kind,
      title: span.name,
      status: span.status,
      errorMessage: span.errorMessage,
      statusMessage: span.statusMessage,
      latencyMs: span.latencyMs,
      startedAt: span.startedAt,
      input: span.input,
      reasoning: extractReasoning(span.output),
      reasoningSegments: extractReasoningSegments(span.output),
      output: span.output,
      metrics: {
        durationMs: span.durationMs ?? span.latencyMs,
      },
      parameters: {},
      metadata: span.metadata,
      raw: span,
    };
  }
  const generation = detail.generations.find((item) => item.id === selected.id);
  if (!generation) return null;
  return {
    kind: generation.operation,
    title: generation.name ?? generation.model ?? generation.operation,
    status: generation.status,
    errorMessage: generation.errorMessage,
    statusMessage: generation.statusMessage,
    latencyMs: generation.latencyMs,
    startedAt: generation.startedAt,
    input: generation.input,
    reasoning: generation.reasoningText ?? extractReasoning(generation.output),
    reasoningSegments: extractReasoningSegments(generation.output),
    output: generation.outputText ?? generation.output,
    metrics: {
      durationMs: generation.durationMs ?? generation.latencyMs,
      promptTokens: generation.promptTokens ?? generation.inputTokens,
      completionTokens: generation.completionTokens ?? generation.outputTokens,
      totalTokens: generation.totalTokens,
      usageDetails: generation.usageDetails,
    },
    parameters: generation.modelParameters ?? {},
    metadata: {
      provider: generation.provider,
      model: generation.model,
      usage: generation.usage,
      finishReason: generation.finishReason,
      rawCaptureMode: generation.rawCaptureMode,
      providerRequestId: generation.providerRequestId,
      providerStatusCode: generation.providerStatusCode,
      ...generation.metadata,
    },
    raw: generation,
  };
}

function FilterFacet({
  children,
  defaultOpen = false,
  label,
  summary,
}: {
  children?: React.ReactNode;
  defaultOpen?: boolean;
  label: string;
  summary?: string;
}) {
  return (
    <details className="group border-b border-border" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 hover:bg-accent/40">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-foreground">{label}</div>
          {summary ? <div className="truncate text-[11px] text-muted-foreground">{summary}</div> : null}
        </div>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      {children ? <div className="space-y-1.5 px-3 pb-2">{children}</div> : null}
    </details>
  );
}

function WorkspaceFilter({
  selectedScope,
  workspaceId,
  workspaceName,
  workspaces,
  onWorkspaceChange,
}: {
  selectedScope: string;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaces: Array<{ id: string; name: string }>;
  onWorkspaceChange: (workspaceId: string) => void;
}) {
  const selectedLabel = selectedScope === ALL_WORKSPACES ? "All workspaces" : workspaceName;
  return (
    <FilterFacet defaultOpen label="Workspace" summary={selectedLabel ?? undefined}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-xs transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent aria-expanded:bg-sidebar-accent"
            type="button"
          >
            <span className="flex-1 truncate text-left font-medium">{selectedLabel ?? "Workspace"}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 rounded-lg" side="bottom" sideOffset={4}>
          <DropdownMenuLabel className="text-xs text-muted-foreground">Workspaces</DropdownMenuLabel>
          <DropdownMenuItem
            className={cn("gap-2 p-2", selectedScope === ALL_WORKSPACES && "bg-accent/60")}
            onClick={() => onWorkspaceChange(ALL_WORKSPACES)}
          >
            <span className="flex-1 truncate text-left font-medium">All workspaces</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {workspaces.map((workspace, index) => (
            <DropdownMenuItem
              className={cn("gap-2 p-2", selectedScope !== ALL_WORKSPACES && workspace.id === workspaceId && "bg-accent/60")}
              key={workspace.id}
              onClick={() => onWorkspaceChange(workspace.id)}
            >
              <span className="flex-1 truncate text-left">{workspace.name}</span>
              <span className="text-xs text-muted-foreground">⌘{index + 1}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="gap-2 p-2">
            <span className="flex-1 truncate text-left font-medium text-muted-foreground">Add workspace</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </FilterFacet>
  );
}

function NameFilter({
  options,
  selectedNames,
  onSelectedNamesChange,
}: {
  options: string[];
  selectedNames: string[];
  onSelectedNamesChange: (names: string[]) => void;
}) {
  const summary = selectedNames.length === 0
    ? "all"
    : selectedNames.length === 1
      ? selectedNames[0]
      : `${selectedNames.length} selected`;
  return (
    <FilterFacet defaultOpen label="Name" summary={summary}>
      <div className="space-y-1">
        {options.length === 0 ? (
          <p className="text-xs text-muted-foreground">No trace names loaded.</p>
        ) : options.map((name) => {
          const selected = selectedNames.includes(name);
          return (
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent/60",
                selected && "bg-accent/60 text-foreground",
              )}
              key={name}
              onClick={() => {
                onSelectedNamesChange(
                  selected ? selectedNames.filter((item) => item !== name) : [...selectedNames, name],
                );
              }}
              type="button"
            >
              <span className={cn("flex h-3.5 w-3.5 items-center justify-center rounded border border-border text-[10px]", selected && "border-primary bg-primary text-primary-foreground")}>{selected ? "✓" : ""}</span>
              <span className="min-w-0 flex-1 truncate">{name}</span>
            </button>
          );
        })}
      </div>
    </FilterFacet>
  );
}

function FilterPanel({
  visible,
  selectedWorkspaceScope,
  workspaceId,
  workspaceName,
  workspaces,
  onWorkspaceChange,
  status,
  onStatusChange,
  traceNameOptions,
  selectedTraceNames,
  onSelectedTraceNamesChange,
  traceId,
  onTraceIdChange,
  threadId,
  onThreadIdChange,
  userId,
  onUserIdChange,
  onApply,
  onClear,
}: {
  visible: boolean;
  selectedWorkspaceScope: string;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaces: Array<{ id: string; name: string }>;
  onWorkspaceChange: (workspaceId: string) => void;
  status: StatusFilter;
  onStatusChange: (status: StatusFilter) => void;
  traceNameOptions: string[];
  selectedTraceNames: string[];
  onSelectedTraceNamesChange: (names: string[]) => void;
  traceId: string;
  onTraceIdChange: (value: string) => void;
  threadId: string;
  onThreadIdChange: (value: string) => void;
  userId: string;
  onUserIdChange: (value: string) => void;
  onApply: () => void;
  onClear: () => void;
}) {
  if (!visible) return null;
  return (
    <aside className="min-h-0 w-[260px] shrink-0 overflow-hidden border-r border-border bg-card max-lg:hidden lg:flex lg:flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">Filters</h2>
          <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={onClear} type="button">
            Clear all
          </button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div>
          {workspaces.length > 1 ? (
            <WorkspaceFilter
              onWorkspaceChange={onWorkspaceChange}
              selectedScope={selectedWorkspaceScope}
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              workspaces={workspaces}
            />
          ) : null}

          <NameFilter
            onSelectedNamesChange={onSelectedTraceNamesChange}
            options={traceNameOptions}
            selectedNames={selectedTraceNames}
          />

          <FilterFacet label="Trace ID" summary={traceId ? `= ${traceId}` : undefined}>
            <Input
              className="h-7 text-xs"
              onChange={(event) => onTraceIdChange(event.target.value)}
              placeholder="Exact trace ID"
              value={traceId}
            />
          </FilterFacet>

          <FilterFacet label="User ID" summary={userId ? `= ${userId}` : undefined}>
            <Input
              className="h-7 text-xs"
              onChange={(event) => onUserIdChange(event.target.value)}
              placeholder="Filter by user"
              value={userId}
            />
          </FilterFacet>

          <FilterFacet label="Session ID" summary={threadId ? `= ${threadId}` : undefined}>
            <Input
              className="h-7 text-xs"
              onChange={(event) => onThreadIdChange(event.target.value)}
              placeholder="Filter by session"
              value={threadId}
            />
          </FilterFacet>

          <FilterFacet label="Status" summary={status === "all" ? undefined : status}>
            <div className="flex flex-wrap gap-1.5">
              {statusFilters.map((item) => (
                <button
                  className={cn(
                    "rounded border px-2 py-0.5 text-[11px] transition-colors hover:bg-accent",
                    status === item ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground",
                  )}
                  key={item}
                  onClick={() => onStatusChange(item)}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
          </FilterFacet>

          <div className="p-3">
          <Button className="h-8 w-full text-xs" onClick={onApply} size="sm" type="button">
            <Search className="h-4 w-4" />
            Apply filters
          </Button>
          </div>
        </div>
      </ScrollArea>
    </aside>
  );
}

function TraceSummaryBar({ detail }: { detail: LlmTraceDetailResponse | null }) {
  if (!detail) return null;
  const rootGeneration = detail.generations.find((generation) => !generation.parentSpanId)
    ?? detail.generations[detail.generations.length - 1];
  const totalTokens = detail.trace.totalTokens ?? detail.generations.reduce((sum, generation) => sum + (generation.totalTokens ?? 0), 0);
  const reason = statusReason(detail.trace);
  return (
    <div className="border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>{formatTime(detail.trace.startedAt)}</span>
        <span>Status: <span className={cn("font-medium", detail.trace.status === "error" ? "text-red-600 dark:text-red-300" : "text-foreground")}>{detail.trace.status}</span></span>
        <span>Latency: <span className="font-medium text-foreground">{formatLatency(detail.trace.latencyMs)}</span></span>
        <span>Session: <span className="font-medium text-foreground">{detail.trace.sessionId ?? detail.trace.threadId ?? "--"}</span></span>
        <span>User: <span className="font-medium text-foreground">{detail.trace.userDisplayName ?? detail.trace.userId ?? "--"}</span></span>
        <span>Env: <span className="font-medium text-foreground">{detail.trace.environment ?? "--"}</span></span>
        <span>Observations: <span className="font-medium text-foreground">{detail.trace.observationCount ?? detail.spans.length + detail.generations.length}</span></span>
        <span>Model: <span className="font-medium text-foreground">{detail.trace.model ?? rootGeneration?.model ?? "--"}</span></span>
        <span>Tokens: <span className="font-medium text-foreground">{totalTokens > 0 ? totalTokens : "--"}</span></span>
      </div>
      {reason ? (
        <div className="mt-2">
          <ErrorMessageBlock>Error: {reason}</ErrorMessageBlock>
        </div>
      ) : null}
    </div>
  );
}

function TraceTree({
  detail,
  loading,
  selected,
  onSelect,
}: {
  detail: LlmTraceDetailResponse | null;
  loading: boolean;
  selected: SelectedNode | null;
  onSelect: (node: SelectedNode) => void;
}) {
  const rows = React.useMemo(() => buildTree(detail), [detail]);
  const defaultCollapsedIds = React.useMemo(
    () => new Set(rows.filter((row) => row.defaultCollapsed).map((row) => row.id)),
    [rows],
  );
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    setExpandedIds(new Set());
  }, [detail?.trace.traceId]);

  const visibleRows = React.useMemo(() => {
    const hiddenDepths: number[] = [];
    return rows.filter((row) => {
      while (
        hiddenDepths.length > 0 &&
        row.depth <= hiddenDepths[hiddenDepths.length - 1]!
      ) {
        hiddenDepths.pop();
      }
      if (hiddenDepths.length > 0) {
        return false;
      }
      const collapsed =
        row.hasChildren &&
        defaultCollapsedIds.has(row.id) &&
        !expandedIds.has(row.id);
      if (collapsed) {
        hiddenDepths.push(row.depth);
      }
      return true;
    });
  }, [defaultCollapsedIds, expandedIds, rows]);

  const toggleExpanded = React.useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading trace tree...
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
        Select a trace row to view its call tree.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-0.5 pr-2">
        {visibleRows.map((row) => {
          const Icon = row.icon;
          const collapsed =
            row.hasChildren &&
            defaultCollapsedIds.has(row.id) &&
            !expandedIds.has(row.id);
          return (
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/40",
                selected?.kind === row.node.kind && selected.id === row.node.id && "bg-accent/60",
              )}
              key={`${row.kind}:${row.id}`}
              onClick={() => onSelect(row.node)}
              style={{ paddingLeft: `${12 + row.depth * 24}px` }}
              type="button"
            >
              {row.hasChildren && row.defaultCollapsed ? (
                <span
                  className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleExpanded(row.id);
                  }}
                  role="button"
                  tabIndex={-1}
                  title={collapsed ? "Show child observations" : "Hide child observations"}
                >
                  <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", !collapsed && "rotate-90")} />
                </span>
              ) : (
                <span className="h-3.5 w-3.5 shrink-0" />
              )}
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-foreground">{row.label}</span>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {row.kind} · {formatLatency(row.latencyMs)} · {formatTime(row.startedAt)}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}

function TraceLogView({
  detail,
  selected,
  onSelect,
}: {
  detail: LlmTraceDetailResponse | null;
  selected: SelectedNode | null;
  onSelect: (node: SelectedNode) => void;
}) {
  if (!detail) {
    return <EmptySection label="Select a trace to view the timeline." />;
  }
  const rows = buildTree(detail).sort((a, b) => {
    const left = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const right = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return left - right;
  });
  const traceStart = detail.trace.startedAt ? new Date(detail.trace.startedAt).getTime() : Math.min(...rows.map((row) => row.startedAt ? new Date(row.startedAt).getTime() : Date.now()));
  const traceDuration = Math.max(detail.trace.latencyMs ?? 1, 1);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div>
          <h4 className="text-sm font-medium text-foreground">Timeline</h4>
          <p className="text-xs text-muted-foreground">Chronological observations with relative start and duration.</p>
        </div>
        <Badge variant="secondary">{rows.length} observations</Badge>
      </div>
      <div className="grid grid-cols-[260px_96px_minmax(240px,1fr)_92px] border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
        <div>Observation</div>
        <div>Type</div>
        <div>Timeline</div>
        <div>Latency</div>
      </div>
      {rows.map((row) => {
        const Icon = row.icon;
        const isSelected = selected?.kind === row.node.kind && selected.id === row.node.id;
        const rowStart = row.startedAt ? new Date(row.startedAt).getTime() : traceStart;
        const offset = Math.max(0, ((rowStart - traceStart) / traceDuration) * 100);
        const width = Math.max(1.5, Math.min(100 - offset, ((row.latencyMs ?? 1) / traceDuration) * 100));
        return (
          <button
            className={cn(
              "grid w-full grid-cols-[260px_96px_minmax(240px,1fr)_92px] items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent/40",
              isSelected && "bg-accent/60",
            )}
            key={`${row.kind}:${row.id}`}
            onClick={() => onSelect(row.node)}
            type="button"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium text-foreground">{row.label}</span>
            </div>
            <div className="truncate text-xs text-muted-foreground">{row.kind}</div>
            <div className="relative h-6 rounded bg-muted">
              <div
                className={cn(
                  "absolute top-1 h-4 rounded",
                  row.node.kind === "generation" ? "bg-blue-500/70" : row.kind === "tool" ? "bg-purple-500/70" : "bg-emerald-500/70",
                )}
                style={{ left: `${offset}%`, width: `${width}%` }}
              />
            </div>
            <div className="text-xs text-muted-foreground">{formatLatency(row.latencyMs)}</div>
          </button>
        );
      })}
    </div>
  );
}

function NodeDetail({
  detail,
  onSelect,
  selected,
}: {
  detail: LlmTraceDetailResponse | null;
  onSelect: (node: SelectedNode) => void;
  selected: SelectedNode | null;
}) {
  const node = selectedNodeData(detail, selected);

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
        Select an item from the trace tree.
      </div>
    );
  }

  const raw = toRecord(node.raw);
  const metrics = toRecord(node.metrics);
  const usage = extractUsage(node.output) ?? extractUsage(node.raw);
  const inputTokens = metrics?.promptTokens ?? raw?.promptTokens ?? raw?.inputTokens ?? usage?.inputTokens ?? usage?.input_tokens;
  const outputTokens = metrics?.completionTokens ?? raw?.completionTokens ?? raw?.outputTokens ?? usage?.outputTokens ?? usage?.output_tokens;
  const totalTokens = metrics?.totalTokens ?? raw?.totalTokens ?? usage?.totalTokens ?? usage?.total_tokens;
  const outputToolCalls = extractToolCalls(node.output);
  const hasReasoning =
    !isEmptyPayload(node.reasoning) || Boolean(node.reasoningSegments?.length);
  const outputWithoutReasoning = hasReasoning
    ? omitRecordKeys(node.output, ["reasoning", "reasoningText", "reasoningSummary", "reasoningSegments"])
    : node.output;
  const selectedObservationTitle = detail && selected?.kind === "trace"
    ? detail.trace.name
    : node.title;
  const reason = statusReason(node);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-foreground">{node.title}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{node.kind}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge variant="secondary">Latency: {formatLatency(node.latencyMs)}</Badge>
              {inputTokens || outputTokens || totalTokens ? (
                <Badge variant="secondary">
                  {String(inputTokens ?? 0)} prompt -&gt; {String(outputTokens ?? 0)} completion (sum {String(totalTokens ?? 0)})
                </Badge>
              ) : null}
            </div>
          </div>
          <Badge className={cn("border", statusClassName(node.status))} variant="outline">
            {node.status}
          </Badge>
        </div>
        {reason ? (
          <div className="mt-3">
            <ErrorMessageBlock>{reason}</ErrorMessageBlock>
          </div>
        ) : null}
      </div>

      <Tabs className="min-h-0 flex-1 p-3" defaultValue="preview">
        <TabsList className="h-8">
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="log">Log View</TabsTrigger>
          <TabsTrigger value="formatted">Formatted</TabsTrigger>
          <TabsTrigger value="json">JSON</TabsTrigger>
        </TabsList>
        <TabsContent className="mt-3 max-h-[calc(100vh-280px)] space-y-4 overflow-auto pr-2" value="preview">
          <div className="px-2 text-sm font-semibold text-foreground">{selectedObservationTitle}</div>
          <PreviewSection title="Input">
            <StructuredValue value={node.input} />
          </PreviewSection>
          {hasReasoning ? (
            <PreviewSection title="Reasoning">
              <ReasoningView reasoning={node.reasoning} segments={node.reasoningSegments} />
            </PreviewSection>
          ) : null}
          <PreviewSection title="Output">
            <StructuredValue fallbackRole="assistant" unwrapToolOutput={node.kind === "tool"} value={outputWithoutReasoning} />
          </PreviewSection>
          {outputToolCalls.length > 0 ? (
            <PreviewSection title="Tool calls">
              <ToolCallList value={outputToolCalls} />
            </PreviewSection>
          ) : null}
          {hasUsefulPayload(node.parameters) ? (
            <PreviewSection title="Model parameters">
              <KeyValueTable value={node.parameters} />
            </PreviewSection>
          ) : null}
          {hasUsefulPayload(node.metrics) ? (
            <PreviewSection title="Metrics">
              <KeyValueTable value={node.metrics} />
            </PreviewSection>
          ) : null}
          {hasUsefulPayload(node.metadata) ? (
            <PreviewSection title="Metadata">
              <KeyValueTable value={node.metadata} />
            </PreviewSection>
          ) : null}
        </TabsContent>
        <TabsContent className="mt-3 max-h-[calc(100vh-280px)] overflow-auto pr-2" value="log">
          <TraceLogView detail={detail} onSelect={onSelect} selected={selected} />
        </TabsContent>
        <TabsContent className="mt-3 max-h-[calc(100vh-280px)] space-y-4 overflow-auto pr-2" value="formatted">
          <Section title="Input"><StructuredValue value={node.input} /></Section>
          {hasReasoning ? <Section title="Reasoning"><ReasoningView reasoning={node.reasoning} segments={node.reasoningSegments} /></Section> : null}
          <Section title="Output"><StructuredValue fallbackRole="assistant" unwrapToolOutput={node.kind === "tool"} value={outputWithoutReasoning} /></Section>
          {hasUsefulPayload(node.parameters) ? <Section title="Model parameters"><KeyValueTable value={node.parameters} /></Section> : null}
          {hasUsefulPayload(node.metrics) ? <Section title="Metrics"><KeyValueTable value={node.metrics} /></Section> : null}
          {hasUsefulPayload(node.metadata) ? <Section title="Metadata"><KeyValueTable value={node.metadata} /></Section> : null}
        </TabsContent>
        <TabsContent className="mt-3 max-h-[calc(100vh-280px)] overflow-auto pr-2" value="json">
          <JsonBlock value={node.raw} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function ObservabilityPage() {
  const { organizationId, switchWorkspace, workspaceId, workspaceName, workspaces } = useDashboardChatState();
  const [traces, setTraces] = React.useState<LlmTraceSummary[]>([]);
  const [detail, setDetail] = React.useState<LlmTraceDetailResponse | null>(null);
  const [selectedTraceKey, setSelectedTraceKey] = React.useState<string | null>(null);
  const [selectedNode, setSelectedNode] = React.useState<SelectedNode | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadingList, setLoadingList] = React.useState(false);
  const [loadingDetail, setLoadingDetail] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [selectedTraceNames, setSelectedTraceNames] = React.useState<string[]>([]);
  const [traceId, setTraceId] = React.useState("");
  const [threadId, setThreadId] = React.useState("");
  const [userId, setUserId] = React.useState("");
  const [filtersVisible, setFiltersVisible] = React.useState(true);
  const [selectedWorkspaceScope, setSelectedWorkspaceScope] = React.useState<string | null>(
    workspaceId ?? (organizationId ? ALL_WORKSPACES : null),
  );
  const listRequestIdRef = React.useRef(0);
  const detailRequestIdRef = React.useRef(0);
  const allWorkspacesSelected = selectedWorkspaceScope === ALL_WORKSPACES;
  const selectedWorkspaceId = allWorkspacesSelected ? null : selectedWorkspaceScope;

  React.useEffect(() => {
    if (!selectedWorkspaceScope) {
      setSelectedWorkspaceScope(workspaceId ?? (organizationId ? ALL_WORKSPACES : null));
    }
  }, [organizationId, selectedWorkspaceScope, workspaceId]);

  const loadTraces = React.useCallback(async (cursor?: string | null) => {
    if (!selectedWorkspaceScope) {
      return;
    }
    if (allWorkspacesSelected && !organizationId) {
      return;
    }
    if (!allWorkspacesSelected && !selectedWorkspaceId) {
      return;
    }
    const requestId = listRequestIdRef.current + 1;
    listRequestIdRef.current = requestId;
    setLoadingList(true);
    setError(null);
    try {
      const query = {
        limit: LIST_LIMIT,
        cursor: cursor ?? undefined,
        status: status === "all" ? undefined : status,
        traceId: traceId.trim() || undefined,
        threadId: threadId.trim() || undefined,
        userId: userId.trim() || undefined,
      };
      const page = allWorkspacesSelected
        ? await llmObservabilityClient.listTeamTraces(organizationId!, query)
        : await llmObservabilityClient.listWorkspaceTraces(selectedWorkspaceId!, query);
      if (requestId !== listRequestIdRef.current) {
        return;
      }
      setTraces((current) => (cursor ? [...current, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (requestId !== listRequestIdRef.current) {
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load traces");
    } finally {
      if (requestId === listRequestIdRef.current) {
        setLoadingList(false);
      }
    }
  }, [allWorkspacesSelected, organizationId, selectedWorkspaceId, selectedWorkspaceScope, status, threadId, traceId, userId]);

  const traceNameOptions = React.useMemo(
    () => Array.from(new Set(traces.map((trace) => trace.name))).sort((a, b) => a.localeCompare(b)),
    [traces],
  );

  const visibleTraces = React.useMemo(
    () => traces.filter((trace) => traceMatchesNameFilter(trace, selectedTraceNames)),
    [selectedTraceNames, traces],
  );
  const hasTraceNameFilter = selectedTraceNames.length > 0;

  React.useEffect(() => {
    listRequestIdRef.current += 1;
    detailRequestIdRef.current += 1;
    setTraces([]);
    setDetail(null);
    setSelectedTraceKey(null);
    setSelectedNode(null);
    setDrawerOpen(false);
    setNextCursor(null);
    void loadTraces(null);
  }, [loadTraces]);

  const openTrace = React.useCallback(async (traceId: string, traceWorkspaceId?: string | null) => {
    if (!selectedWorkspaceScope) {
      return;
    }
    if (allWorkspacesSelected && !organizationId) {
      return;
    }
    if (!allWorkspacesSelected && !selectedWorkspaceId) {
      return;
    }
    const detailWorkspaceId = allWorkspacesSelected ? traceWorkspaceId : selectedWorkspaceId;
    if (!detailWorkspaceId) {
      setError("Trace workspace is required to load team trace detail");
      return;
    }
    setSelectedTraceKey(traceSelectionKey(traceId, detailWorkspaceId));
    setDrawerOpen(true);
    setLoadingDetail(true);
    setError(null);
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    try {
      const nextDetail = allWorkspacesSelected
        ? await llmObservabilityClient.getTeamTrace(organizationId!, traceId, { workspaceId: detailWorkspaceId })
        : await llmObservabilityClient.getWorkspaceTrace(detailWorkspaceId, traceId);
      if (requestId !== detailRequestIdRef.current) {
        return;
      }
      setDetail(nextDetail);
      setSelectedNode({ kind: "trace", id: nextDetail.trace.traceId });
    } catch (err) {
      if (requestId !== detailRequestIdRef.current) {
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load trace detail");
      setDetail(null);
    } finally {
      if (requestId === detailRequestIdRef.current) {
        setLoadingDetail(false);
      }
    }
  }, [allWorkspacesSelected, organizationId, selectedWorkspaceId, selectedWorkspaceScope]);

  const handleWorkspaceChange = React.useCallback((nextWorkspaceId: string) => {
    setSelectedWorkspaceScope(nextWorkspaceId);
    if (nextWorkspaceId !== ALL_WORKSPACES) {
      void switchWorkspace(nextWorkspaceId);
    }
  }, [switchWorkspace]);

  const clearFilters = React.useCallback(() => {
    setStatus("all");
    setSelectedTraceNames([]);
    setTraceId("");
    setThreadId("");
    setUserId("");
  }, []);

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <FilterPanel
          visible={filtersVisible}
          onApply={() => void loadTraces(null)}
          onClear={clearFilters}
          onSelectedTraceNamesChange={setSelectedTraceNames}
          onStatusChange={setStatus}
          onTraceIdChange={setTraceId}
          onThreadIdChange={setThreadId}
          onUserIdChange={setUserId}
          onWorkspaceChange={handleWorkspaceChange}
          selectedWorkspaceScope={selectedWorkspaceScope ?? workspaceId ?? ALL_WORKSPACES}
          status={status}
          selectedTraceNames={selectedTraceNames}
          traceId={traceId}
          traceNameOptions={traceNameOptions}
          threadId={threadId}
          userId={userId}
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          workspaces={workspaces}
        />

        <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
          <div className="border-b border-border px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Button className="h-8 gap-1.5 px-2 text-xs" onClick={() => setFiltersVisible((visible) => !visible)} size="sm" type="button" variant="outline">
                  <SlidersHorizontal className="h-4 w-4" />
                  {filtersVisible ? "Hide filters" : "Show filters"}
                </Button>
                <Badge className="h-6 px-2 text-[11px]" variant="secondary">All time</Badge>
                <Badge className="h-6 px-2 text-[11px]" variant="outline">{traces.length} loaded</Badge>
                {hasTraceNameFilter ? (
                  <Badge className="h-6 px-2 text-[11px]" variant="outline">{visibleTraces.length} shown</Badge>
                ) : null}
                <Badge className="h-6 px-2 text-[11px]" variant="secondary">Page size {LIST_LIMIT}</Badge>
                {allWorkspacesSelected ? <Badge className="h-6 px-2 text-[11px]" variant="outline">All workspaces</Badge> : null}
              </div>
              <Button className="h-8 px-2 text-xs" onClick={() => void loadTraces(null)} size="sm" type="button" variant="outline">
                {loadingList ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Refresh
              </Button>
            </div>
            {error ? <p className="mt-2 text-xs text-red-600 dark:text-red-300">{error}</p> : null}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <table className="w-full table-fixed text-xs">
              <thead className="sticky top-0 z-10 border-b border-border bg-card text-left text-[11px] text-muted-foreground">
                <tr>
                  <th className="w-[150px] px-3 py-1.5 font-medium">Timestamp</th>
                  <th className="w-[300px] px-3 py-1.5 font-medium">Name</th>
                  {allWorkspacesSelected ? <th className="w-[160px] px-3 py-1.5 font-medium">Workspace</th> : null}
                  <th className="w-[90px] px-3 py-1.5 font-medium">Status</th>
                  <th className="w-[90px] px-3 py-1.5 font-medium">Latency</th>
                  <th className="w-[150px] px-3 py-1.5 font-medium">Model</th>
                  <th className="w-[90px] px-3 py-1.5 font-medium">Tokens</th>
                  <th className="w-[90px] px-3 py-1.5 font-medium">Obs.</th>
                  <th className="w-[190px] px-3 py-1.5 font-medium">Session ID</th>
                  <th className="w-[140px] px-3 py-1.5 font-medium">User</th>
                  <th className="w-[190px] px-3 py-1.5 font-medium">Trace ID</th>
                  <th className="w-[36px] px-3 py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {visibleTraces.map((trace) => (
                  <tr
                    className={cn(
                      "cursor-pointer border-b border-border transition-colors hover:bg-accent/40",
                      selectedTraceKey === traceSelectionKey(trace.traceId, trace.workspaceId) && "bg-accent/60",
                    )}
                    key={trace.id}
                    onClick={() => void openTrace(trace.traceId, trace.workspaceId)}
                  >
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{formatTime(trace.startedAt)}</td>
                    <td className="px-3 py-1.5">
                      <div className="truncate font-medium text-foreground">{trace.name}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">Session: {sessionLabel(trace)}</div>
                    </td>
                    {allWorkspacesSelected ? (
                      <td className="truncate px-3 py-1.5 text-muted-foreground">{workspaceLabel(workspaces, trace.workspaceId)}</td>
                    ) : null}
                    <td className="px-3 py-1.5">
                      <Badge className={cn("h-5 border px-1.5 text-[10px]", statusClassName(trace.status))} variant="outline">
                        {trace.status}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{formatLatency(trace.latencyMs)}</td>
                    <td className="truncate px-3 py-1.5 text-muted-foreground">{trace.model ?? "--"}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{trace.totalTokens ?? "--"}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{trace.observationCount ?? "--"}</td>
                    <td className="truncate px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{sessionLabel(trace)}</td>
                    <td className="truncate px-3 py-1.5 text-muted-foreground">{trace.userDisplayName ?? trace.userId ?? "--"}</td>
                    <td className="truncate px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{trace.traceId}</td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">
                      <ChevronRight className="ml-auto h-3.5 w-3.5" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleTraces.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">
                {loadingList ? "Loading traces..." : traces.length === 0 ? "No traces found." : "No traces match the current search."}
              </div>
            ) : null}
            {nextCursor ? (
              <div className="border-t border-border p-3">
                <Button className="w-full" onClick={() => void loadTraces(nextCursor)} size="sm" type="button" variant="outline">
                  Load older traces
                </Button>
              </div>
            ) : null}
          </ScrollArea>
        </section>
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          className="w-[min(1120px,94vw)] gap-0 p-0 sm:max-w-none"
          overlayClassName="bg-black/30"
          side="right"
        >
          <SheetHeader className="border-b border-border px-4 py-3 pr-12">
            <SheetTitle className="truncate text-base">
              {detail ? `${detail.trace.name}: ${detail.trace.traceId}` : "Trace"}
            </SheetTitle>
            <SheetDescription className="truncate">
              {detail ? `Session ID: ${detail.trace.sessionId ?? detail.trace.threadId ?? "--"}` : selectedTraceKey ?? "Trace detail"}
            </SheetDescription>
          </SheetHeader>
          <TraceSummaryBar detail={detail} />
          <div className="min-h-0 flex-1">
            <div className="grid h-full min-h-0 md:grid-cols-[320px_minmax(0,1fr)]">
              <div className="min-h-0 overflow-hidden border-r border-border p-2">
                <div className="mb-2 px-2 text-xs font-medium text-muted-foreground">Timeline</div>
                <TraceTree
                  detail={detail}
                  loading={loadingDetail}
                  onSelect={setSelectedNode}
                  selected={selectedNode}
                />
              </div>
              <div className="min-h-0 overflow-hidden">
                <NodeDetail detail={detail} onSelect={setSelectedNode} selected={selectedNode} />
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </main>
  );
}
