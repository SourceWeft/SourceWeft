import { createHash } from "node:crypto";
import {
  MARKET_MCP_INSPECT_LIMITS,
  MARKET_MCP_TOOL_MAX_NESTING,
  marketMcpInspectedToolSchema,
  marketMcpNestsDeeperThan,
  type MarketMcpInspectedTool,
} from "@sourceweft/market-contracts";

/**
 * Canonical form, hash and diff of a tool list (Issue #367, tool revisions).
 *
 * A revision is recorded only when the canonical list differs from the
 * source's previous one, so everything that is formatting rather than content
 * is removed here: the order of the tools, the order of an object's keys at
 * any depth, and the whitespace in descriptions. Array order inside a schema
 * (`enum`, `oneOf`, `prefixItems`, …) can carry meaning and is preserved.
 */

/**
 * Bump when the canonical form changes. Revisions keep the version that made
 * their hash; `recordToolRevision` re-derives an older revision's hash from
 * its stored list before comparing, so a bump alone never creates a revision.
 */
export const TOOL_CANONICAL_VERSION = 1;

/** Full lists kept per item and source; older revisions keep their diff only. */
export const TOOL_REVISIONS_KEPT_FULL = 50;

/**
 * Rows kept per item and source, diff-only ones included: the oldest beyond
 * this are deleted (the numbering keeps counting from the newest).
 */
export const TOOL_REVISIONS_KEPT_ROWS = 500;

/**
 * New revisions one item and source may make in a rolling 24 hours. A list
 * that keeps changing (a server that rotates its tools, a misbehaving writer)
 * would otherwise grow the history, and the public change log, without bound.
 */
export const TOOL_REVISIONS_PER_DAY = 24;

/**
 * A members' observation is the least trusted source: whoever connects with a
 * credential that narrows the server (a scope, a toolset header, a plan) sees a
 * different list. It may make this many new revisions per listing in a rolling
 * 24 hours, on a budget of its own (the other sources' are never touched).
 */
export const MEMBER_OBSERVED_REVISIONS_PER_DAY = 3;

/**
 * A members' observation that is a strict subset (by tool name) of the latest
 * one confirmed this recently is not recorded: a reduced list is more likely a
 * restricted account than a real change. A superset or a different list is.
 */
export const MEMBER_OBSERVED_SUBSET_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const TOOL_REVISION_LIMITS = MARKET_MCP_INSPECT_LIMITS;

export type CanonicalTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: Record<string, unknown>;
};

/** What differs inside a tool that exists in both lists. */
export const TOOL_FIELDS = [
  "title",
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
] as const;
export type ToolField = (typeof TOOL_FIELDS)[number];

export type ToolRevisionDiff = {
  added: string[];
  removed: string[];
  changed: Array<{ name: string; fields: ToolField[] }>;
};

export class ToolRevisionInputError extends Error {
  constructor(
    readonly code:
      | "TOOLS_INVALID"
      | "TOOLS_TOO_MANY"
      | "TOOLS_DUPLICATE_NAME",
    message: string,
  ) {
    super(message);
    this.name = "ToolRevisionInputError";
  }
}

/**
 * Validates and bounds a list with the owner-submission limits (200 tools,
 * 2,000-character descriptions, 32 KiB of schemas and annotations per tool).
 * Rejects rather than truncates: a clipped list must never be recorded as if
 * it were the server's list. Duplicate names are rejected too, since the diff
 * is keyed by name.
 */
export function validateTools(tools: readonly unknown[]): MarketMcpInspectedTool[] {
  if (!Array.isArray(tools)) {
    throw new ToolRevisionInputError("TOOLS_INVALID", "Tools must be a list");
  }
  if (tools.length > TOOL_REVISION_LIMITS.tools) {
    throw new ToolRevisionInputError(
      "TOOLS_TOO_MANY",
      `A tool list may hold at most ${TOOL_REVISION_LIMITS.tools} tools`,
    );
  }
  const parsed: MarketMcpInspectedTool[] = [];
  const names = new Set<string>();
  for (const tool of tools) {
    // Before anything recursive touches it (the contract checks this too).
    if (marketMcpNestsDeeperThan(tool, MARKET_MCP_TOOL_MAX_NESTING)) {
      throw new ToolRevisionInputError(
        "TOOLS_INVALID",
        `A tool may nest values at most ${MARKET_MCP_TOOL_MAX_NESTING} levels deep`,
      );
    }
    const result = marketMcpInspectedToolSchema.safeParse(tool);
    if (!result.success) {
      throw new ToolRevisionInputError(
        "TOOLS_INVALID",
        result.error.issues[0]?.message ?? "A tool is invalid",
      );
    }
    if (names.has(result.data.name)) {
      throw new ToolRevisionInputError(
        "TOOLS_DUPLICATE_NAME",
        `Tool name listed twice: ${result.data.name}`,
      );
    }
    names.add(result.data.name);
    parsed.push(result.data);
  }
  return parsed;
}

// Own data property, so a key named `__proto__` stays a key (a plain
// assignment would set the prototype and silently drop it).
function setOwn(target: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

// Callers have bounded the nesting (see `validateTools`).
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) setOwn(out, key, sortKeys(entry));
    }
    return out;
  }
  return value;
}

function compareCodeUnits(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeText(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text : undefined;
}

/** The canonical tools: sorted by name, keys sorted, text normalised. */
export function canonicalizeTools(tools: readonly MarketMcpInspectedTool[]): CanonicalTool[] {
  return tools
    .map((tool): CanonicalTool => {
      const canonical: CanonicalTool = {
        name: tool.name,
        inputSchema: sortKeys(tool.inputSchema ?? {}) as Record<string, unknown>,
        annotations: sortKeys(tool.annotations ?? {}) as Record<string, unknown>,
      };
      const title = normalizeText(tool.title);
      if (title) canonical.title = title;
      const description = normalizeText(tool.description);
      if (description) canonical.description = description;
      if (tool.outputSchema) {
        canonical.outputSchema = sortKeys(tool.outputSchema) as Record<string, unknown>;
      }
      return sortKeys(canonical) as CanonicalTool;
    })
    .sort((a, b) => compareCodeUnits(a.name, b.name));
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

export function hashCanonicalTools(canonical: readonly CanonicalTool[]): string {
  return sha256(JSON.stringify(canonical));
}

/** Hash of a withdrawal: never equal to the hash of any list, empty or not. */
export const WITHDRAWN_TOOLS_HASH = sha256("withdrawn");

export function diffTools(
  previous: readonly CanonicalTool[],
  next: readonly CanonicalTool[],
): ToolRevisionDiff {
  const before = new Map(previous.map((tool) => [tool.name, tool]));
  const after = new Map(next.map((tool) => [tool.name, tool]));
  const diff: ToolRevisionDiff = { added: [], removed: [], changed: [] };
  for (const [name, tool] of after) {
    const old = before.get(name);
    if (!old) {
      diff.added.push(name);
      continue;
    }
    const fields = TOOL_FIELDS.filter(
      (field) => JSON.stringify(old[field] ?? null) !== JSON.stringify(tool[field] ?? null),
    );
    if (fields.length > 0) diff.changed.push({ name, fields });
  }
  for (const name of before.keys()) {
    if (!after.has(name)) diff.removed.push(name);
  }
  diff.added.sort(compareCodeUnits);
  diff.removed.sort(compareCodeUnits);
  diff.changed.sort((a, b) => compareCodeUnits(a.name, b.name));
  return diff;
}
