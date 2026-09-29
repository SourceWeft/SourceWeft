import { createHash } from "node:crypto";
import type {
  MarketMcpManifest,
  McpAuthType,
  McpTransport,
} from "@sourceweft/market-contracts";
import type { RegistryInput, RegistryServerJson } from "../types";
import {
  MCP_OVERVIEW_PROMPT_VERSION,
  MCP_OVERVIEW_TAXONOMY_VERSION,
  mcpOverviewPassages,
} from "./prompt";

/**
 * What an MCP server's AI overview is written from (design §4.3): the manifest
 * facts that matter to someone deciding whether to install it, the registry
 * description, and the usage-related parts of its README — cleaned, bounded
 * and fingerprinted.
 *
 * All of it is third-party text. ./prompt.ts quotes it to the model as data;
 * this file only selects and shapes it. No database, no model calls.
 *
 * Anything here that changes what the model is shown for the same source —
 * the README budget, the heading rules, the fact caps — must come with a bump
 * of MCP_OVERVIEW_PROMPT_VERSION, which is how stored overviews learn that
 * their input fingerprint is stale.
 */

// README budget, mirroring the skill overview's SKILL.md budget.
export const MCP_OVERVIEW_README_MAX_CHARS = 24_000;
// What one README section may take before every other selected section has
// had its turn; the remainder is handed out afterwards, in priority order.
export const MCP_OVERVIEW_README_SECTION_MAX_CHARS = 4_000;
// Marks README text left out between (or after) the excerpts.
export const MCP_OVERVIEW_README_OMISSION_MARKER = "[…]";
// A line cut to fit the budget is kept only if at least this much of it fits.
const MIN_PARTIAL_LINE_CHARS = 80;

// Entries with no README and a description shorter than this are skipped.
export const MCP_OVERVIEW_SKIP_MIN_DESCRIPTION_CHARS = 40;

// Caps on the manifest facts, in items or characters.
export const MCP_OVERVIEW_FACT_LIMITS = {
  descriptionChars: 2_000,
  tools: 40,
  toolNameChars: 100,
  toolDescriptionChars: 300,
  variables: 30,
  headers: 20,
  variableDescriptionChars: 200,
  packages: 5,
  packageIdentifierChars: 200,
  nameChars: 200,
} as const;

// Environment variable and header names: identifiers only. Anything else
// (prose, a value pasted into the name field) is dropped, not shown.
const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const SHORT_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,31}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type McpOverviewReadmeSource = { markdown: string; sha256: string };

export type McpOverviewSource = {
  /** The stored manifest (`manifest_json`) of the version being described. */
  manifest: MarketMcpManifest;
  /** The upstream registry's description, verbatim. */
  registryDescription: string | null | undefined;
  /** The stored README and the hash it was stored under; null when none. */
  readme: McpOverviewReadmeSource | null;
  /**
   * The upstream `server.json` (registry entry or repository file), when the
   * caller has it. `MarketMcpManifest` has no packages or environment
   * variables, so this is the only source of those names. Read tolerantly.
   */
  registryServer?: RegistryServerJson | null;
};

export type McpOverviewVariableFact = {
  name: string;
  secret: boolean;
  required: boolean;
  description?: string;
};

export type McpOverviewPackageFact = {
  registryType: string;
  identifier: string;
  transport?: string;
  runtimeHint?: string;
};

export type McpOverviewToolFact = {
  name: string;
  description?: string;
  risk?: "read" | "write" | "destructive";
};

/** The manifest facts shown to the model. Names only — never a value. */
export type McpManifestFacts = {
  identifier: string;
  name: string;
  provider?: string;
  homepage?: string;
  transport: McpTransport;
  /** Reachable as a hosted endpoint. */
  remote: boolean;
  /** Runs as a process on the user's machine (a package, or stdio). */
  local: boolean;
  /** Scheme and host of the endpoint; never its path or query. */
  endpointOrigin?: string;
  desktopOnly: boolean;
  webExecutable: boolean;
  auth: { type: McpAuthType; required: boolean; headerNames: string[] };
  envVars: McpOverviewVariableFact[];
  headers: McpOverviewVariableFact[];
  packages: McpOverviewPackageFact[];
  tools: McpOverviewToolFact[];
  /** Tools in the manifest, including any beyond the cap. */
  toolCount: number;
};

export type McpReadmeExcerpt = {
  /** What the prompt quotes: the segments in document order, with markers. */
  excerpt: string;
  /** The README text selected, one entry per section; evidence must be in one. */
  segments: string[];
  /** Whether any usable README text was left out. */
  truncated: boolean;
};

export type McpOverviewInput = {
  facts: McpManifestFacts;
  registryDescription: string | null;
  readme: (McpReadmeExcerpt & { sha256: string }) | null;
  inputSha256: string;
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** The prompt input for one MCP server version, and its fingerprint. */
export function buildMcpOverviewInput(
  source: McpOverviewSource,
): McpOverviewInput {
  const facts = extractMcpManifestFacts(
    source.manifest,
    source.registryServer ?? null,
  );
  const registryDescription = normalizeDescription(source.registryDescription);
  const readme = source.readme
    ? {
        sha256: normalizeSha256(source.readme.sha256),
        ...extractMcpReadmeExcerpt(source.readme.markdown),
      }
    : null;
  const inputSha256 = computeMcpOverviewInputSha256({
    promptVersion: MCP_OVERVIEW_PROMPT_VERSION,
    taxonomyVersion: MCP_OVERVIEW_TAXONOMY_VERSION,
    readmeSha256: readme?.sha256 ?? null,
    manifestFacts: facts,
    registryDescription,
  });
  return { facts, registryDescription, readme, inputSha256 };
}

/**
 * Nothing worth describing: no usable README (none stored, or nothing left
 * once badges, markup and boilerplate sections are removed) and a description
 * too short to say what the server does — or nothing in the input the
 * overview's categories could cite as evidence (no numbered passage; see
 * ./passages.ts).
 */
export function shouldSkipMcpOverview(input: McpOverviewInput): boolean {
  const hasReadme = (input.readme?.segments.length ?? 0) > 0;
  const descriptionChars = Array.from(
    (input.registryDescription ?? "").trim(),
  ).length;
  if (
    !hasReadme &&
    descriptionChars < MCP_OVERVIEW_SKIP_MIN_DESCRIPTION_CHARS
  ) {
    return true;
  }
  return mcpOverviewPassages(input).length === 0;
}

/**
 * sha256 over a canonical JSON (object keys sorted at every depth) of what
 * the overview depends on. The same input hashes the same however its objects
 * were built; any change to a field changes the hash.
 */
export function computeMcpOverviewInputSha256(parts: {
  promptVersion: string;
  taxonomyVersion: string;
  readmeSha256: string | null;
  manifestFacts: McpManifestFacts;
  registryDescription: string | null;
}): string {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex");
}

/** JSON with object keys sorted; undefined properties are left out. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

// ---------------------------------------------------------------------------
// Manifest facts
// ---------------------------------------------------------------------------

/**
 * The facts someone deciding whether to install the server needs: how it
 * runs, what it authenticates with, which secrets and settings it asks for
 * (by name), which packages ship it, and its tools. Values are never read.
 */
export function extractMcpManifestFacts(
  manifest: MarketMcpManifest,
  registryServer: RegistryServerJson | null = null,
): McpManifestFacts {
  const server = isRecord(registryServer) ? registryServer : null;
  const packageEntries = arrayOf(server?.packages);
  const remoteEntries = arrayOf(server?.remotes);

  const envVars = new VariableSet(MCP_OVERVIEW_FACT_LIMITS.variables, false);
  const headers = new VariableSet(MCP_OVERVIEW_FACT_LIMITS.headers, true);
  const packages: McpOverviewPackageFact[] = [];
  const packageKeys = new Set<string>();
  for (const entry of packageEntries) {
    if (!isRecord(entry)) continue;
    for (const variable of arrayOf(entry.environmentVariables)) {
      envVars.add(variable);
    }
    const transport = isRecord(entry.transport) ? entry.transport : null;
    for (const header of arrayOf(transport?.headers)) headers.add(header);
    const registryType = shortToken(entry.registryType);
    const identifier = cleanLine(
      entry.identifier,
      MCP_OVERVIEW_FACT_LIMITS.packageIdentifierChars,
    );
    if (!registryType || !identifier) continue;
    const key = `${registryType.toLowerCase()}\u0000${identifier}`;
    if (packageKeys.has(key)) continue;
    packageKeys.add(key);
    packages.push(
      withoutUndefined({
        registryType,
        identifier,
        transport: shortToken(transport?.type),
        runtimeHint: shortToken(entry.runtimeHint),
      }),
    );
  }
  let hasRemote = false;
  for (const entry of remoteEntries) {
    if (!isRecord(entry)) continue;
    if (typeof entry.url === "string" && entry.url.trim()) hasRemote = true;
    for (const header of arrayOf(entry.headers)) headers.add(header);
  }

  const endpointOrigin = urlOrigin(manifest.endpointUrl);
  const auth = manifest.auth ?? {
    type: "none" as const,
    required: false,
    allowedHeaderNames: [],
  };
  const tools = manifest.tools ?? [];

  return withoutUndefined({
    identifier: cleanLine(
      manifest.identifier,
      MCP_OVERVIEW_FACT_LIMITS.nameChars,
    ),
    name: cleanLine(manifest.name, MCP_OVERVIEW_FACT_LIMITS.nameChars),
    provider:
      cleanLine(manifest.providerName, MCP_OVERVIEW_FACT_LIMITS.nameChars) ||
      undefined,
    homepage: urlWithoutQuery(manifest.homepageUrl),
    transport: manifest.transport,
    remote: Boolean(endpointOrigin) || hasRemote,
    local: manifest.transport === "stdio" || packages.length > 0,
    endpointOrigin,
    desktopOnly: manifest.desktopOnly === true,
    webExecutable: manifest.webExecutable !== false,
    auth: {
      type: auth.type,
      required: auth.required === true,
      headerNames: uniqueSorted(
        [auth.headerName, ...(auth.allowedHeaderNames ?? [])].filter(
          (name): name is string =>
            typeof name === "string" && VARIABLE_NAME_RE.test(name.trim()),
        ),
        MCP_OVERVIEW_FACT_LIMITS.headers,
      ),
    },
    envVars: envVars.list(),
    headers: headers.list(),
    packages: packages.slice(0, MCP_OVERVIEW_FACT_LIMITS.packages),
    tools: tools.slice(0, MCP_OVERVIEW_FACT_LIMITS.tools).flatMap((tool) => {
      const name = cleanLine(tool.name, MCP_OVERVIEW_FACT_LIMITS.toolNameChars);
      if (!name) return [];
      const description = cleanLine(
        tool.description ?? tool.title,
        MCP_OVERVIEW_FACT_LIMITS.toolDescriptionChars,
      );
      const risk =
        tool.risk === "read" ||
        tool.risk === "write" ||
        tool.risk === "destructive"
          ? tool.risk
          : undefined;
      return [
        withoutUndefined({ name, description: description || undefined, risk }),
      ];
    }),
    toolCount: tools.length,
  });
}

/**
 * Environment variables or headers by name, merged across packages and
 * remotes: a name is secret or required if any declaration says so. Only the
 * name, the flags and the author's description are kept — `value`,
 * `default`, `placeholder` and hints are never read.
 */
class VariableSet {
  private readonly byKey = new Map<string, McpOverviewVariableFact>();
  constructor(
    private readonly cap: number,
    private readonly caseInsensitive: boolean,
  ) {}

  add(entry: unknown) {
    if (!isRecord(entry)) return;
    const input = entry as RegistryInput;
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!VARIABLE_NAME_RE.test(name)) return;
    const key = this.caseInsensitive ? name.toLowerCase() : name;
    const description = cleanLine(
      input.description,
      MCP_OVERVIEW_FACT_LIMITS.variableDescriptionChars,
    );
    const existing = this.byKey.get(key);
    if (existing) {
      existing.secret ||= input.isSecret === true;
      existing.required ||= input.isRequired === true;
      if (!existing.description && description) {
        existing.description = description;
      }
      return;
    }
    this.byKey.set(
      key,
      withoutUndefined({
        name,
        secret: input.isSecret === true,
        required: input.isRequired === true,
        description: description || undefined,
      }),
    );
  }

  list(): McpOverviewVariableFact[] {
    return [...this.byKey.values()]
      .sort((a, b) => compareStrings(a.name, b.name))
      .slice(0, this.cap);
  }
}

// ---------------------------------------------------------------------------
// README excerpt
// ---------------------------------------------------------------------------

// Priority of a README section. Lower is taken first.
const TIER_USAGE = 0;
const TIER_INTRO = 1;
const TIER_OTHER = 2;
const TIER_SKIP = 3;
type Tier = 0 | 1 | 2 | 3;

// Headings about using the server, and the other things an install decision
// turns on (limits, pricing, security). Matched on lowercased heading text.
const USAGE_HEADING_RE =
  /\b(features?|capabilit(?:y|ies)|what (?:it|you) can do|usage|how to use|using|use cases?|getting started|get started|quick ?start|tools?|available tools|commands?|configur(?:e|ation|ing)|config|settings|options|environment(?: variables)?|env(?: vars?)?|variables|set ?up|install(?:ation|ing)?|authenticat(?:e|ion)|auth|authoriz(?:e|ation)|api ?keys?|credentials?|tokens?|examples?|api|endpoints?|requirements?|prerequisites?|resources?|prompts?|integrations?|connect(?:ing|ion)?|clients?|deploy(?:ment|ing)?|run(?:ning)?|parameters?|limits?|limitations?|rate limits?|pric(?:e|es|ing)|payments?|paying|paid|costs?|billing|fees?|permissions?|scopes?|security|privacy|transport)\b|功能|特性|用法|使用|安装|安裝|配置|设置|設定|工具|示例|範例|例子|认证|認證|鉴权|鑑權|接口|介面|快速开始|快速開始|环境变量|環境變數|要求|依赖|依賴|权限|權限|安全|隐私|隱私|价格|價格|定价|定價|限制/;
// Headings that introduce the server.
const INTRO_HEADING_RE =
  /\b(overview|about|introduction|intro|what is|what it does|description|summary|why|how it works)\b|简介|簡介|介绍|介紹|概述|概覽|关于|關於/;
// Boilerplate an install decision never turns on. Left out entirely, along
// with the sections under them.
// Short generic words count only as the whole heading ("Support", not
// "Supported clients"; "Contents", not "Page contents").
const SKIP_HEADING_RE =
  /^(?:licen[cs]es?|authors?|maintainers?|thanks|credits|sponsors?|backers|badges|community|support(?: us| the project)?|feedback|contents|table of contents|toc|citation|cite|stargazers)$|\b(?:licen[cs]e|contribut(?:e|ing|ors?|ions?)|changelog|change log|release notes|(?:version|release|star|change) history|acknowledge?ments?|sponsorship|donat(?:e|ions?)|code of conduct|roadmap)\b|许可|許可|贡献|貢獻|致谢|致謝|更新日志|更新日誌|目录|目錄/;

type MdLine =
  | { kind: "prose"; text: string }
  | { kind: "open"; text: string; close: string }
  | { kind: "code"; text: string }
  | { kind: "close"; text: string };

type Section = {
  level: number;
  heading: string | null;
  lines: MdLine[];
  tier: Tier;
};

/**
 * The usage-related parts of a README, within `limit` characters.
 *
 * The README is split at its headings. Sections about using the server come
 * first (features, usage, tools, configuration, setup, authentication,
 * examples, API, …), then the introduction, then everything else; licence,
 * contributing, changelog and similar sections are dropped. Each section
 * first gets up to MCP_OVERVIEW_README_SECTION_MAX_CHARS so one long section
 * cannot crowd out the rest, then leftover room goes to the sections that
 * were cut, in the same order. The result keeps document order, marks gaps
 * with MCP_OVERVIEW_README_OMISSION_MARKER, and never leaves a code fence
 * open. HTML comments, images, badges and HTML tags are removed and
 * whitespace collapsed first.
 */
export function extractMcpReadmeExcerpt(
  markdown: string,
  limit = MCP_OVERVIEW_README_MAX_CHARS,
): McpReadmeExcerpt {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError("Invalid README excerpt limit");
  }
  const all = splitSections(scanMarkdown(markdown));
  // A heading with nothing under it but subsections ("## Connect", then
  // "### Cursor") travels with its first subsection, so the context stays.
  for (const [index, section] of all.entries()) {
    const next = all[index + 1];
    if (
      section.heading !== null &&
      next &&
      next.level > section.level &&
      !hasBody(section)
    ) {
      next.lines = [...section.lines.filter(isHeadingLine), ...next.lines];
    }
  }
  const sections = all.filter(
    (section) => section.tier !== TIER_SKIP && hasBody(section),
  );
  const marker = MCP_OVERVIEW_README_OMISSION_MARKER;
  // The most any piece adds besides its own text: a separator with a marker.
  const separator = `\n\n${marker}\n\n`.length;
  const order = sections
    .map((section, index) => ({ tier: section.tier, index }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map(({ index }) => index);

  const taken = new Map<number, { text: string; complete: boolean }>();
  // Room for one trailing marker is set aside from the start.
  let remaining = limit - separator;
  for (const index of order) {
    const allowance = Math.min(
      MCP_OVERVIEW_README_SECTION_MAX_CHARS,
      remaining - separator,
    );
    if (allowance <= 0) break;
    const piece = takeSection(sections[index]!, allowance);
    if (!piece) continue;
    taken.set(index, piece);
    remaining -= piece.text.length + separator;
  }
  for (const index of order) {
    const previous = taken.get(index);
    if (previous?.complete) continue;
    const allowance = previous
      ? previous.text.length + remaining
      : remaining - separator;
    if (allowance <= (previous?.text.length ?? 0)) continue;
    const piece = takeSection(sections[index]!, allowance);
    if (!piece || piece.text.length <= (previous?.text.length ?? 0)) continue;
    taken.set(index, piece);
    remaining -= piece.text.length - (previous?.text.length ?? -separator);
  }

  const picked = [...taken.entries()].sort((a, b) => a[0] - b[0]);
  let excerpt = "";
  let expected = 0;
  let previousComplete = true;
  for (const [index, piece] of picked) {
    const gap = index !== expected || !previousComplete;
    excerpt += excerpt
      ? gap
        ? `\n\n${marker}\n\n`
        : "\n\n"
      : gap
        ? `${marker}\n\n`
        : "";
    excerpt += piece.text;
    expected = index + 1;
    previousComplete = piece.complete;
  }
  const truncated =
    picked.length < sections.length || picked.some(([, p]) => !p.complete);
  if (picked.length > 0 && (expected < sections.length || !previousComplete)) {
    excerpt += `\n\n${marker}`;
  }
  return {
    excerpt,
    segments: picked.map(([, piece]) => piece.text),
    truncated,
  };
}

/**
 * Lines, with fenced code kept verbatim (trailing space aside) and prose
 * cleaned: HTML comments, images, badges and HTML tags removed, links reduced
 * to their text, whitespace collapsed.
 */
function scanMarkdown(markdown: string): MdLine[] {
  const text = markdown
    .replace(/^\ufeff/, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(
      /[\u200b\u200c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff\uE000-\uE002]/g,
      "",
    );
  const lines: MdLine[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length === 0) return;
    for (const line of cleanProse(prose.join("\n")).split("\n")) {
      lines.push({ kind: "prose", text: line });
    }
    prose = [];
  };
  let fence: { char: string; length: number; close: string } | null = null;
  let inComment = false;
  for (const raw of text.split("\n")) {
    if (fence) {
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(raw)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) {
        lines.push({ kind: "close", text: fence.close });
        fence = null;
      } else {
        lines.push({ kind: "code", text: raw.trimEnd() });
      }
      continue;
    }
    let line = raw;
    if (inComment) {
      const end = line.indexOf("-->");
      if (end < 0) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    line = line.replace(/<!--[\s\S]*?-->/g, "");
    const commentStart = line.indexOf("<!--");
    if (commentStart >= 0) {
      line = line.slice(0, commentStart);
      inComment = true;
    }
    // Any indentation: READMEs indent fences inside list items.
    const open = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1]!.startsWith("`") && open[2]!.includes("`"))) {
      flushProse();
      const marker = open[1]!;
      const info = (open[2]!.trim().split(/\s+/)[0] ?? "").slice(0, 20);
      fence = { char: marker[0]!, length: marker.length, close: marker };
      lines.push({ kind: "open", text: `${marker}${info}`, close: marker });
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return lines;
}

// Elements whose content is not README prose.
const DROPPED_ELEMENT_RE = /<(script|style|svg|picture)\b[\s\S]*?<\/\1\s*>/gi;
// Tags of common HTML elements; their text content stays. Restricted to known
// names so a placeholder such as <your-api-key> is kept.
const HTML_TAG_RE =
  /<\/?(?:a|abbr|b|big|blockquote|br|center|cite|code|dd|del|details|div|dl|dt|em|figcaption|figure|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|picture|pre|q|s|samp|small|source|span|strike|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|tr|tt|u|ul|video)(?=[\s/>])[^<>]*>/gi;

// Private-use characters: inline-code placeholders and removed-tag gaps.
// Stripped from the README before cleaning, so they cannot be forged.
const STASH_OPEN = String.fromCharCode(0xe000);
const STASH_CLOSE = String.fromCharCode(0xe001);
const TAG_GAP = String.fromCharCode(0xe002);

function cleanProse(block: string): string {
  // Inline code is kept as written; stash it so markup rules leave it alone.
  const stash: string[] = [];
  let text = block.replace(/(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g, (span) => {
    stash.push(span);
    return `${STASH_OPEN}${stash.length - 1}${STASH_CLOSE}`;
  });
  text = text
    .replace(DROPPED_ELEMENT_RE, "")
    // Images, including the ones inside badge links.
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "")
    .replace(/!\[[^\]\n]*\]\[[^\]\n]*\]/g, "")
    // A gap, so <summary>More</summary>Details stays two words; it becomes a
    // space below, after indentation is measured.
    .replace(HTML_TAG_RE, TAG_GAP)
    // Links left with no text (a badge was all they held), then links.
    .replace(/\[\s*\]\([^)\n]*\)/g, "")
    .replace(/\[\s*\]\[[^\]\n]*\]/g, "")
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, "$1")
    .replace(/<(https?:\/\/[^\s<>]+)>/g, "$1")
    .replace(/&nbsp;/gi, TAG_GAP);
  return text
    .split("\n")
    .filter((line) => !/^ {0,3}\[[^\]\n]+\]:\s*\S/.test(line))
    .map((line) => {
      const indent = /^[ \t]*/.exec(line)![0].replace(/\t/g, "  ").length;
      const rest = line
        .replaceAll(TAG_GAP, " ")
        .replace(/[ \t\u00a0]+/g, " ")
        .trim();
      return rest ? `${" ".repeat(Math.min(indent, 8))}${rest}` : "";
    })
    .join("\n")
    .replace(
      /\uE000(\d+)\uE001/g,
      (_, index: string) => stash[Number(index)] ?? "",
    );
}

const ATX_HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_OR_BLOCK_RE = /^\s*(?:[-*+]|\d+[.)]|>|\|)(?:\s|$)/;

function splitSections(lines: MdLine[]): Section[] {
  const sections: Section[] = [];
  let current: Section = {
    level: 0,
    heading: null,
    lines: [],
    tier: TIER_OTHER,
  };
  sections.push(current);
  const startSection = (level: number, heading: string) => {
    current = {
      level,
      heading,
      lines: [{ kind: "prose", text: `${"#".repeat(level)} ${heading}` }],
      tier: TIER_OTHER,
    };
    sections.push(current);
  };
  for (const line of lines) {
    if (line.kind !== "prose") {
      current.lines.push(line);
      continue;
    }
    const atx = ATX_HEADING_RE.exec(line.text);
    const atxText = atx ? headingText(atx[2] ?? "") : "";
    if (atx && atxText) {
      startSection(atx[1]!.length, atxText);
      continue;
    }
    const underline = SETEXT_UNDERLINE_RE.exec(line.text);
    const last = current.lines.at(-1);
    const beforeLast = current.lines.at(-2);
    const startsSection =
      current.heading !== null && current.lines.length === 1;
    if (
      underline &&
      last?.kind === "prose" &&
      last.text.trim() &&
      !startsSection &&
      !LIST_OR_BLOCK_RE.test(last.text) &&
      (!beforeLast || (beforeLast.kind === "prose" && !beforeLast.text.trim()))
    ) {
      const text = headingText(last.text);
      if (text) {
        current.lines.pop();
        startSection(underline[1]!.startsWith("=") ? 1 : 2, text);
        continue;
      }
    }
    if (THEMATIC_BREAK_RE.test(line.text) || atx) continue;
    current.lines.push(line);
  }

  // Tiers: a heading's own match, else the nearest matched ancestor's; the
  // text before the first heading and the first headed section are the
  // introduction; the rest is "other".
  const ancestors: Array<{ level: number; tier: Tier | null }> = [];
  let firstHeaded = true;
  for (const section of sections) {
    section.lines = tidyBlankLines(section.lines);
    if (section.heading === null) {
      section.tier = TIER_INTRO;
      continue;
    }
    while (ancestors.length && ancestors.at(-1)!.level >= section.level) {
      ancestors.pop();
    }
    const own = headingTier(section.heading);
    const inherited =
      [...ancestors].reverse().find((ancestor) => ancestor.tier !== null)
        ?.tier ?? null;
    const explicit =
      own === TIER_SKIP || inherited === TIER_SKIP
        ? TIER_SKIP
        : (own ?? inherited);
    section.tier = explicit ?? (firstHeaded ? TIER_INTRO : TIER_OTHER);
    firstHeaded = false;
    ancestors.push({ level: section.level, tier: explicit });
  }
  return sections;
}

function headingText(value: string): string {
  return value
    .replace(/[ \t]+#+[ \t]*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function headingTier(heading: string): Tier | null {
  // Letters and digits only (no emoji or punctuation), without numbering.
  const text = heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\d+ /, "");
  if (SKIP_HEADING_RE.test(text)) return TIER_SKIP;
  if (USAGE_HEADING_RE.test(text)) return TIER_USAGE;
  if (INTRO_HEADING_RE.test(text)) return TIER_INTRO;
  return null;
}

/** No leading or trailing blank lines after the heading, no blank runs. */
function tidyBlankLines(lines: MdLine[]): MdLine[] {
  const out: MdLine[] = [];
  for (const line of lines) {
    const blank = line.kind === "prose" && !line.text.trim();
    const last = out.at(-1);
    const afterHeading =
      out.length === 1 && lines[0] === last && isHeadingLine(last);
    const afterBlank = last?.kind === "prose" && !last.text.trim();
    if (blank && (!last || afterHeading || afterBlank)) continue;
    out.push(line);
  }
  while (
    out.length &&
    out.at(-1)!.kind === "prose" &&
    !out.at(-1)!.text.trim()
  ) {
    out.pop();
  }
  return out;
}

function isHeadingLine(line: MdLine | undefined): boolean {
  return line?.kind === "prose" && /^#{1,6} /.test(line.text);
}

/** A line of section content: not a heading, not blank, not a fence. */
function isBodyLine(line: MdLine): boolean {
  return (
    (line.kind === "prose" || line.kind === "code") &&
    line.text.trim() !== "" &&
    !isHeadingLine(line)
  );
}

function hasBody(section: Section): boolean {
  return section.lines.some(isBodyLine);
}

/**
 * The longest prefix of a section within `maxChars`, cut at a line boundary
 * (or inside one overlong line), with any open code fence closed. Null when
 * no body line fits.
 */
function takeSection(
  section: Section,
  maxChars: number,
): { text: string; complete: boolean } | null {
  const out: string[] = [];
  let used = 0;
  let openFence: string | null = null;
  let complete = true;
  let body = false;
  for (const line of section.lines) {
    const separator = out.length ? 1 : 0;
    const nextFence: string | null =
      line.kind === "open"
        ? line.close
        : line.kind === "close"
          ? null
          : openFence;
    const reserve = nextFence ? nextFence.length + 1 : 0;
    const isBody = isBodyLine(line);
    if (used + separator + line.text.length + reserve <= maxChars) {
      out.push(line.text);
      used += separator + line.text.length;
      openFence = nextFence;
      body ||= isBody;
      continue;
    }
    complete = false;
    if (line.kind === "prose" || line.kind === "code") {
      const room = maxChars - used - separator - reserve - 1;
      if (room >= MIN_PARTIAL_LINE_CHARS) {
        out.push(`${cutToLength(line.text, room)}…`);
        body ||= isBody;
      }
    }
    break;
  }
  if (openFence) out.push(openFence);
  return body ? { text: out.join("\n"), complete } : null;
}

/** At most `length` UTF-16 units, never splitting a surrogate pair. */
function cutToLength(text: string, length: number): string {
  let out = "";
  for (const char of text) {
    if (out.length + char.length > length) break;
    out += char;
  }
  return out.trimEnd();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One line of plain text, at most `max` characters; "" for non-strings. */
function cleanLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value
    // eslint-disable-next-line no-control-regex
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(text);
  return chars.length <= max
    ? text
    : `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

function normalizeDescription(value: string | null | undefined): string | null {
  return cleanLine(value, MCP_OVERVIEW_FACT_LIMITS.descriptionChars) || null;
}

function normalizeSha256(value: string): string {
  const sha = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_RE.test(sha)) {
    throw new TypeError("README sha256 must be 64 hexadecimal characters");
  }
  return sha;
}

function shortToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return SHORT_TOKEN_RE.test(token) ? token : undefined;
}

function urlOrigin(value: string | undefined): string | undefined {
  const url = httpUrl(value);
  return url ? url.origin : undefined;
}

function urlWithoutQuery(value: string | undefined): string | undefined {
  const url = httpUrl(value);
  if (!url) return undefined;
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
}

function httpUrl(value: string | undefined): URL | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function uniqueSorted(values: string[], cap: number): string[] {
  const byKey = new Map<string, string>();
  for (const value of values) {
    const name = value.trim();
    if (!byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  }
  return [...byKey.values()].sort(compareStrings).slice(0, cap);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
