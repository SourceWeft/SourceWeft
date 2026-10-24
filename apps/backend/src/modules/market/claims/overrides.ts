import {
  MARKET_MCP_TOOL_SOURCE_OWNER_SUBMITTED,
  marketMcpInspectedToolSchema,
  type MarketItemSummary,
  type MarketMcpOwnerField,
  type MarketMcpOwnerLayer,
  type MarketMcpToolManifest,
} from "@sourceweft/market-contracts";
import {
  mcpOwnerOverridesInputSchema,
  type McpOwnerOverridesInput,
} from "@sourceweft/contracts";
import type { marketMcpOwnerOverrides } from "@sourceweft/db";

/**
 * The owner layer (Issue #367, W7): a verified claimant's corrections,
 * applied on read as the top layer of the public item and manifest. Pure;
 * ./repository.ts loads the rows and read-repository.ts calls this.
 *
 * Owner-submitted tools are shown — they are the only tool list a server
 * that refuses anonymous callers can have — but never trusted for
 * unattended execution: every one carries `risk: "unknown"`, exactly like a
 * probe-sourced tool, whatever the submission said.
 */

export type McpOwnerOverridesRow = typeof marketMcpOwnerOverrides.$inferSelect;

/**
 * What applying the layer needs: the stored row, or the same fields read
 * back through a JSON object (timestamps then arrive as ISO strings).
 */
export type McpOwnerOverridesSource = Pick<
  McpOwnerOverridesRow,
  "overridesJson" | "toolsJson"
> & {
  toolsSubmittedAt: Date | string | null;
  updatedAt: Date | string;
  /** Who wrote each field (and the tool list, under "tools"): name → user id. */
  authorsJson?: Record<string, string> | null;
  /**
   * The members holding a verified claim, on a raw row that has not been
   * filtered yet (the overview's SQL). `effectiveOwnerOverrides` applies it.
   */
  verifiedUsers?: readonly string[] | null;
};

export type AuthorMap = Record<string, string>;
/** The tool list's key in an authors map. */
export const TOOLS_AUTHOR_KEY = "tools";

/**
 * What of the stored layer is shown: a field, or the tool list, only while
 * the member who wrote it holds a verified claim. A co-owner's fields stay
 * when another owner is revoked or blocked; a field with no recorded author
 * is not shown. Null when nobody holds a claim.
 */
export function visibleOwnerOverrides<T extends McpOwnerOverridesSource>(
  row: T,
  verified: ReadonlySet<string>,
): T | null {
  if (verified.size === 0) return null;
  const authors = row.authorsJson ?? {};
  const shown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row.overridesJson ?? {})) {
    const author = authors[key];
    if (author && verified.has(author)) shown[key] = value;
  }
  const toolsAuthor = authors[TOOLS_AUTHOR_KEY];
  const showTools = Boolean(toolsAuthor && verified.has(toolsAuthor));
  const { verifiedUsers: _verifiedUsers, ...rest } = row;
  return {
    ...rest,
    overridesJson: shown,
    toolsJson: showTools ? row.toolsJson : null,
    toolsSubmittedAt: showTools ? row.toolsSubmittedAt : null,
  } as unknown as T;
}

/** A row that may still carry its verified members: filtered to what shows. */
export function effectiveOwnerOverrides(
  row: McpOwnerOverridesSource | null | undefined,
): McpOwnerOverridesSource | null {
  if (!row) return null;
  if (!row.verifiedUsers) return row;
  return visibleOwnerOverrides(row, new Set(row.verifiedUsers));
}

/**
 * The stored fields and authors after `userId` saves `next` (the whole set,
 * as their form shows it). A value the saver left as it was keeps its author
 * while that author still holds a claim; anything else is the saver's. Fields
 * the saver cannot see (their author holds no claim now) are kept as they
 * were — a save never wipes or takes over another member's quarantined
 * work — unless the saver writes that field themselves. The tool list's
 * author is untouched.
 */
export function mergeAuthoredFields(input: {
  previousValues: Record<string, unknown>;
  previousAuthors: AuthorMap;
  next: Record<string, unknown>;
  userId: string;
  verified: ReadonlySet<string>;
}): { values: Record<string, unknown>; authors: AuthorMap } {
  const values: Record<string, unknown> = {};
  const authors: AuthorMap = {};
  for (const [key, value] of Object.entries(input.previousValues)) {
    const author = input.previousAuthors[key];
    const hidden = !(author && input.verified.has(author));
    if (hidden && !(key in input.next)) {
      values[key] = value;
      if (author) authors[key] = author;
    }
  }
  for (const [key, value] of Object.entries(input.next)) {
    const previousAuthor = input.previousAuthors[key];
    const unchanged =
      key in input.previousValues && input.previousValues[key] === value;
    values[key] = value;
    authors[key] =
      unchanged && previousAuthor && input.verified.has(previousAuthor)
        ? previousAuthor
        : input.userId;
  }
  const toolsAuthor = input.previousAuthors[TOOLS_AUTHOR_KEY];
  if (toolsAuthor) authors[TOOLS_AUTHOR_KEY] = toolsAuthor;
  return { values, authors };
}

/**
 * What blocking `userId` removes from the stored layer: every field they
 * wrote, and the tool list if they wrote it. Null when they wrote nothing.
 */
export function clearAuthoredBy(
  row: Pick<McpOwnerOverridesSource, "overridesJson" | "authorsJson">,
  userId: string,
): { overridesJson: Record<string, unknown>; authorsJson: AuthorMap; clearTools: boolean } | null {
  const authors = row.authorsJson ?? {};
  const overridesJson: Record<string, unknown> = {};
  const authorsJson: AuthorMap = {};
  let changed = false;
  for (const [key, value] of Object.entries(row.overridesJson ?? {})) {
    if (authors[key] === userId) {
      changed = true;
      continue;
    }
    overridesJson[key] = value;
    if (authors[key]) authorsJson[key] = authors[key]!;
  }
  const clearTools = authors[TOOLS_AUTHOR_KEY] === userId;
  if (authors[TOOLS_AUTHOR_KEY] && !clearTools) {
    authorsJson[TOOLS_AUTHOR_KEY] = authors[TOOLS_AUTHOR_KEY]!;
  }
  if (!changed && !clearTools) return null;
  return { overridesJson, authorsJson, clearTools };
}

function isoOf(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** The stored corrections, dropping anything that no longer parses. */
export function ownerOverrideValues(
  json: Record<string, unknown> | null | undefined,
): McpOwnerOverridesInput {
  const parsed = mcpOwnerOverridesInputSchema.safeParse(json ?? {});
  if (parsed.success) return parsed.data;
  // Field by field, so one bad value does not hide the others.
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json ?? {})) {
    const single = mcpOwnerOverridesInputSchema.safeParse({ [key]: value });
    if (single.success) Object.assign(values, single.data);
  }
  return values as McpOwnerOverridesInput;
}

/** The owner's tool list as manifest tools: risk unknown, source marked. */
export function ownerSubmittedTools(
  toolsJson: unknown,
): MarketMcpToolManifest[] {
  if (!Array.isArray(toolsJson)) return [];
  const seen = new Set<string>();
  const tools: MarketMcpToolManifest[] = [];
  for (const entry of toolsJson) {
    const parsed = marketMcpInspectedToolSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.name)) continue;
    seen.add(parsed.data.name);
    tools.push({
      name: parsed.data.name,
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.description !== undefined
        ? { description: parsed.data.description }
        : {}),
      inputSchema: parsed.data.inputSchema,
      ...(parsed.data.outputSchema !== undefined
        ? { outputSchema: parsed.data.outputSchema }
        : {}),
      annotations: parsed.data.annotations,
      risk: "unknown",
      source: MARKET_MCP_TOOL_SOURCE_OWNER_SUBMITTED,
    });
  }
  return tools;
}

type SetValue<K extends keyof McpOwnerOverridesInput> = Exclude<
  McpOwnerOverridesInput[K],
  null | undefined
>;

function setValue<K extends keyof McpOwnerOverridesInput>(
  values: McpOwnerOverridesInput,
  key: K,
): SetValue<K> | undefined {
  const value = values[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  return value as SetValue<K>;
}

/** The layer record: which fields the owner set, and the small facts. */
export function ownerLayerOf(row: McpOwnerOverridesSource): MarketMcpOwnerLayer {
  const values = ownerOverrideValues(row.overridesJson);
  const tools = ownerSubmittedTools(row.toolsJson);
  const fields: MarketMcpOwnerField[] = [];
  for (const key of [
    "iconUrl",
    "summary",
    "description",
    "documentationUrl",
    "homepageUrl",
    "repoUrl",
  ] as const) {
    if (setValue(values, key) !== undefined) fields.push(key);
  }
  if (values.deprecated === true) fields.push("deprecated");
  if (tools.length > 0) fields.push("tools");
  return {
    source: "owner",
    fields,
    documentationUrl: setValue(values, "documentationUrl") ?? null,
    deprecated: values.deprecated === true,
    toolsSubmittedAt: tools.length > 0 ? isoOf(row.toolsSubmittedAt) : null,
    updatedAt: isoOf(row.updatedAt) ?? new Date(0).toISOString(),
  };
}

/**
 * The public item with the owner's corrections on top. `claimed` is set
 * from the claims table whether or not the owner changed anything.
 */
export function applyOwnerOverridesToItem(
  item: MarketItemSummary,
  input: { row: McpOwnerOverridesSource | null; claimed: boolean },
): MarketItemSummary {
  if (!input.row) {
    return { ...item, claimed: input.claimed, deprecated: false, owner: null };
  }
  const values = ownerOverrideValues(input.row.overridesJson);
  const tools = ownerSubmittedTools(input.row.toolsJson);
  const layer = ownerLayerOf(input.row);
  const iconUrl = setValue(values, "iconUrl");
  return {
    ...item,
    ...(iconUrl ? { iconUrl, iconSource: "owner" as const } : {}),
    summary: setValue(values, "summary") ?? item.summary,
    homepageUrl: setValue(values, "homepageUrl") ?? item.homepageUrl,
    repoUrl: setValue(values, "repoUrl") ?? item.repoUrl,
    ...(tools.length > 0
      ? { toolsCount: tools.length, toolsValidation: null }
      : {}),
    claimed: input.claimed,
    deprecated: layer.deprecated,
    owner: layer,
  };
}

/**
 * A stored manifest with the owner's corrections on top. Works on the raw
 * JSON so a manifest that drifted from the schema is passed through as it
 * was (the manifest route validates it on the wire).
 */
export function applyOwnerOverridesToManifest(
  manifestJson: Record<string, unknown>,
  row: McpOwnerOverridesSource | null,
): Record<string, unknown> {
  if (!row) return manifestJson;
  const values = ownerOverrideValues(row.overridesJson);
  const tools = ownerSubmittedTools(row.toolsJson);
  const next: Record<string, unknown> = { ...manifestJson };
  const put = (key: keyof McpOwnerOverridesInput, target = key as string) => {
    const value = setValue(values, key);
    if (value !== undefined) next[target] = value;
  };
  put("iconUrl");
  put("summary");
  put("description");
  put("documentationUrl");
  put("homepageUrl");
  put("repoUrl");
  if (tools.length > 0) next.tools = tools;
  next.owner = ownerLayerOf(row);
  return next;
}
