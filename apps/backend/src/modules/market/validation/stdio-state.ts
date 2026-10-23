import {
  marketMcpToolManifestSchema,
  type MarketMcpToolManifest,
  type MarketMcpValidation,
  type McpStdioValidationReason,
} from "@sourceweft/market-contracts";

/**
 * What one sandboxed start of a stdio package means for the version
 * (Issue #367, W1b): the driver's result file turned into the provenance and
 * manifest it writes, bounded. Pure — the batch (`stdio-validate.ts`) writes
 * what these return.
 */

/** Bounds the stored self-description and tools are kept within. */
export const MCP_STDIO_LIMITS = {
  tools: 200,
  toolDescriptionChars: 2000,
  stringChars: 500,
  instructionsChars: 8000,
  icons: 5,
  detailChars: 500,
  capabilitiesChars: 4000,
} as const;

/** The source the provenance names for a stdio start; W1's probe is "remote-probe". */
export const MCP_STDIO_SELF_DESCRIPTION_SOURCE = "stdio-sandbox";

/**
 * What a validation that ran again finds too old to trust: a version is due
 * again this long after its last success or failure.
 */
export const MCP_STDIO_REVALIDATE_MS = 30 * 24 * 60 * 60 * 1000;

export type McpStdioServerIcon = {
  src: string;
  mimeType?: string;
  sizes?: string[];
};

export type McpStdioServerInfo = {
  name: string;
  title?: string;
  version?: string;
  description?: string;
  websiteUrl?: string;
  icons?: McpStdioServerIcon[];
};

/** The provenance `selfDescription` a stdio start writes (W1's shape). */
export type McpStdioSelfDescription = {
  source: typeof MCP_STDIO_SELF_DESCRIPTION_SOURCE;
  recordedAt: string;
  serverInfo?: McpStdioServerInfo;
  instructions?: string;
  capabilities?: Record<string, unknown>;
};

/** `stdio-driver.mjs`'s result file, after `parseStdioDriverResult`. */
export type McpStdioDriverResult =
  | {
      ok: true;
      protocolVersion?: string;
      serverInfo?: unknown;
      instructions?: unknown;
      capabilities?: unknown;
      tools: unknown[];
      timings: { installMs: number; startMs: number };
      stderrTail: string;
    }
  | {
      ok: false;
      reason: Exclude<McpStdioValidationReason, "unsupported-package">;
      detail: string;
      exitCode?: number | null;
      timings: { installMs: number; startMs: number };
      stderrTail: string;
    };

export type McpStdioOutcome =
  | {
      kind: "success";
      selfDescription: McpStdioSelfDescription;
      validatedAt: string;
      tools: MarketMcpToolManifest[];
    }
  | { kind: "failure"; validation: MarketMcpValidation };

const FAILURE_REASONS = new Set(["install", "start", "protocol", "timeout"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxChars: number) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Array.from(trimmed).slice(0, maxChars).join("");
}

function timings(value: unknown) {
  const record = isRecord(value) ? value : {};
  const number = (item: unknown) =>
    typeof item === "number" && Number.isFinite(item) ? Math.max(0, item) : 0;
  return {
    installMs: number(record.installMs),
    startMs: number(record.startMs),
  };
}

/**
 * The driver's result as it was written, or null when the text is not one:
 * a driver that crashed before writing, or a sandbox that lost the file. A
 * null is an infrastructure failure to retry, never a verdict on the
 * package.
 */
export function parseStdioDriverResult(
  text: string,
): McpStdioDriverResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const stderrTail = boundedString(parsed.stderrTail, 4096) ?? "";
  if (parsed.ok === true) {
    if (!Array.isArray(parsed.tools)) return null;
    return {
      ok: true,
      protocolVersion: boundedString(parsed.protocolVersion, 64),
      serverInfo: parsed.serverInfo,
      instructions: parsed.instructions,
      capabilities: parsed.capabilities,
      tools: parsed.tools,
      timings: timings(parsed.timings),
      stderrTail,
    };
  }
  if (parsed.ok === false) {
    const reason =
      typeof parsed.reason === "string" && FAILURE_REASONS.has(parsed.reason)
        ? (parsed.reason as Exclude<
            McpStdioValidationReason,
            "unsupported-package"
          >)
        : null;
    if (!reason) return null;
    return {
      ok: false,
      reason,
      detail: boundedString(parsed.detail, MCP_STDIO_LIMITS.detailChars) ?? "",
      exitCode:
        typeof parsed.exitCode === "number" ? parsed.exitCode : undefined,
      timings: timings(parsed.timings),
      stderrTail,
    };
  }
  return null;
}

function serverIcons(value: unknown): McpStdioServerIcon[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const icons: McpStdioServerIcon[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const src = boundedString(entry.src, MCP_STDIO_LIMITS.stringChars);
    if (!src || !/^https:\/\//i.test(src)) continue;
    const sizes = Array.isArray(entry.sizes)
      ? entry.sizes
          .map((size) => boundedString(size, 32))
          .filter((size): size is string => Boolean(size))
      : undefined;
    icons.push({
      src,
      ...(boundedString(entry.mimeType, 64)
        ? { mimeType: boundedString(entry.mimeType, 64) }
        : {}),
      ...(sizes && sizes.length > 0 ? { sizes } : {}),
    });
    if (icons.length >= MCP_STDIO_LIMITS.icons) break;
  }
  return icons.length > 0 ? icons : undefined;
}

/** The `serverInfo` of an initialize result, bounded; undefined without a name. */
export function boundedServerInfo(
  value: unknown,
): McpStdioServerInfo | undefined {
  if (!isRecord(value)) return undefined;
  const name = boundedString(value.name, MCP_STDIO_LIMITS.stringChars);
  if (!name) return undefined;
  const optional = (key: string) =>
    boundedString(value[key], MCP_STDIO_LIMITS.stringChars);
  const websiteUrl = optional("websiteUrl");
  const icons = serverIcons(value.icons);
  return {
    name,
    ...(optional("title") ? { title: optional("title") } : {}),
    ...(optional("version") ? { version: optional("version") } : {}),
    ...(optional("description")
      ? { description: optional("description") }
      : {}),
    ...(websiteUrl && /^https?:\/\//i.test(websiteUrl) ? { websiteUrl } : {}),
    ...(icons ? { icons } : {}),
  };
}

/** The server's `capabilities` object, kept only while it serializes small. */
function boundedCapabilities(value: unknown) {
  if (!isRecord(value)) return undefined;
  return JSON.stringify(value).length <= MCP_STDIO_LIMITS.capabilitiesChars
    ? value
    : undefined;
}

/** One `tools/list` entry as a manifest tool, or undefined without a name. */
export function boundedTool(value: unknown): MarketMcpToolManifest | undefined {
  if (!isRecord(value)) return undefined;
  const name = boundedString(value.name, MCP_STDIO_LIMITS.stringChars);
  if (!name) return undefined;
  const parsed = marketMcpToolManifestSchema.safeParse({
    name,
    title: boundedString(value.title, MCP_STDIO_LIMITS.stringChars),
    description: boundedString(
      value.description,
      MCP_STDIO_LIMITS.toolDescriptionChars,
    ),
    inputSchema: isRecord(value.inputSchema) ? value.inputSchema : {},
    outputSchema: isRecord(value.outputSchema) ? value.outputSchema : undefined,
    annotations: isRecord(value.annotations) ? value.annotations : {},
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * What the batch writes for one driver result: on success, the
 * self-description (`source: "stdio-sandbox"`), `validatedAt` and the
 * bounded tools, with duplicate tool names dropped; on failure, the
 * `validation` record with its bounded detail. The tools of a failure are
 * not part of the outcome — the version keeps whatever it has.
 */
export function stdioValidationOutcome(
  result: McpStdioDriverResult,
  now: Date,
): McpStdioOutcome {
  const at = now.toISOString();
  if (!result.ok) {
    return {
      kind: "failure",
      validation: {
        status: "failed",
        reason: result.reason,
        at,
        ...(result.detail ? { detail: result.detail } : {}),
      },
    };
  }
  const tools: MarketMcpToolManifest[] = [];
  const names = new Set<string>();
  for (const entry of result.tools) {
    const tool = boundedTool(entry);
    if (!tool || names.has(tool.name)) continue;
    names.add(tool.name);
    tools.push(tool);
    if (tools.length >= MCP_STDIO_LIMITS.tools) break;
  }
  const serverInfo = boundedServerInfo(result.serverInfo);
  const instructions = boundedString(
    result.instructions,
    MCP_STDIO_LIMITS.instructionsChars,
  );
  const capabilities = boundedCapabilities(result.capabilities);
  return {
    kind: "success",
    validatedAt: at,
    tools,
    selfDescription: {
      source: MCP_STDIO_SELF_DESCRIPTION_SOURCE,
      recordedAt: at,
      ...(serverInfo ? { serverInfo } : {}),
      ...(instructions ? { instructions } : {}),
      ...(capabilities ? { capabilities } : {}),
    },
  };
}

/** The `validation` record for a version whose packages the sandbox cannot run. */
export function unsupportedValidation(
  detail: string,
  now: Date,
): MarketMcpValidation {
  return {
    status: "unsupported",
    reason: "unsupported-package",
    at: now.toISOString(),
    detail: Array.from(detail).slice(0, MCP_STDIO_LIMITS.detailChars).join(""),
  };
}
