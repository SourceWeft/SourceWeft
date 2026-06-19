import { toObjectRecord } from "./content";
import { ContentError } from "../../../content/errors";
import {
  AGENT_TOOL_NAMES,
  getAgentToolConnectorType,
  hasAgentToolCapability,
  isAgentToolDomain,
} from "@sourceweft/agent-tool-registry";
import { normalizeToolInput } from "./tool-utils";

const MAX_OBSERVABLE_TOOL_CONTENT_CHARS = 8_000;

export function compactTraceText(value: string, maxLength = 96) {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function compactObservableToolContent(value: string) {
  const sanitized = value
    .replace(/\0/g, "\uFFFD")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  if (sanitized.length <= MAX_OBSERVABLE_TOOL_CONTENT_CHARS) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_OBSERVABLE_TOOL_CONTENT_CHARS).trimEnd()}\n[Output truncated for display.]`;
}

export function formatDateInTimeZone(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sameToolArgs(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

export function parseToolArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return parseToolArgs(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return toObjectRecord(value) ?? {};
}

export function normalizeToolOutputString(value: unknown) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function parseJsonObject(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    return toObjectRecord(JSON.parse(trimmed) as unknown);
  } catch {
    return null;
  }
}

export function parseJsonObjectText(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    return toObjectRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function decodeXmlAttribute(value: string) {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractXmlAttributes(value: string) {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(/([a-zA-Z_][\w:-]*)='([^']*)'/g)) {
    const key = match[1];
    const rawValue = match[2];
    if (key && rawValue !== undefined) {
      attributes[key] = decodeXmlAttribute(rawValue);
    }
  }
  return attributes;
}

export function extractToolOutputText(output: unknown) {
  if (typeof output === "string") {
    return output;
  }

  const record = toObjectRecord(output);
  if (!record) {
    return null;
  }

  if (typeof record.content === "string") {
    return record.content;
  }

  const kwargs =
    toObjectRecord(record.kwargs) ?? toObjectRecord(record.lc_kwargs);
  const content = kwargs?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const itemRecord = toObjectRecord(item);
        return typeof itemRecord?.text === "string" ? itemRecord.text : null;
      })
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  return null;
}

export function extractToolOutputField(output: unknown, key: string) {
  const records = collectToolOutputRecords(output);
  for (const record of records) {
    const direct = record[key];
    if (typeof direct === "string" && direct.trim().length > 0) {
      return direct.trim();
    }
    if (typeof direct === "number" && Number.isFinite(direct)) {
      return String(direct);
    }
  }

  const outputText = extractToolOutputText(output);
  if (!outputText) {
    return null;
  }

  const match = outputText.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

export function collectToolOutputRecords(output: unknown) {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<Record<string, unknown>>();

  const push = (candidate: unknown) => {
    const record = toObjectRecord(candidate);
    if (!record || seen.has(record)) {
      return;
    }
    seen.add(record);
    records.push(record);

    const content = record.content;
    if (typeof content === "string") {
      push(parseJsonObjectText(content));
    }

    const kwargs =
      toObjectRecord(record.kwargs) ?? toObjectRecord(record.lc_kwargs);
    if (kwargs) {
      push(kwargs);
      if (typeof kwargs.content === "string") {
        push(parseJsonObjectText(kwargs.content));
      }
    }
  };

  push(output);

  if (typeof output === "string") {
    push(parseJsonObjectText(output));
  }

  const outputText = extractToolOutputText(output);
  if (outputText && outputText !== output) {
    push(parseJsonObjectText(outputText));
  }

  return records;
}

export function getPublicStringField(
  record: Record<string, unknown> | null,
  key: string,
) {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function resolveFilesystemPath(input: Record<string, unknown>) {
  for (const key of ["path", "file_path", "filePath"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

export function resolveFilesystemPattern(input: Record<string, unknown>) {
  const value = input.pattern;
  return typeof value === "string" ? value.trim() : "";
}

export function scopeFromPath(path: string) {
  if (path === "/skills" || path.startsWith("/skills/")) {
    return "skills";
  }
  if (path === "/workfiles" || path.startsWith("/workfiles/")) {
    return "work";
  }
  return null;
}

export function filesystemScope(
  input: Record<string, unknown>,
  toolName?: string,
) {
  const declaredScope = input.filesystemScope;
  if (
    declaredScope === "skills" ||
    declaredScope === "work" ||
    declaredScope === "sources"
  ) {
    return declaredScope;
  }
  const pathScope = scopeFromPath(resolveFilesystemPath(input));
  if (pathScope) {
    return pathScope;
  }
  if (toolName && hasAgentToolCapability(toolName, "pattern_scope")) {
    const patternScope = scopeFromPath(resolveFilesystemPattern(input));
    if (patternScope) {
      return patternScope;
    }
  }
  return "sources";
}

export type FilesystemToolScope = ReturnType<typeof filesystemScope>;

export type FilesystemToolVisibility = "internal_instruction" | "normal";

export type SkillInstructionDisplayMetadata = {
  skillSlug: string;
  skillDisplayName: string;
  skillFileName?: string;
  skillPath?: string;
};

export type SkillInstructionDisplayOptions = {
  skillDisplayNamesBySlug?: ReadonlyMap<string, string>;
};

export type SkillInstructionReadOutput = {
  type: "skill_instruction_read";
  redacted: true;
  skillFileName?: string;
  skillPath?: string;
};

export const SKILL_INSTRUCTION_READ_OUTPUT = {
  type: "skill_instruction_read",
  redacted: true,
} satisfies SkillInstructionReadOutput;

function formatSkillSlugForDisplay(slug: string) {
  return slug
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getSkillInstructionDisplayMetadataFromPath(
  path: string,
  options: SkillInstructionDisplayOptions = {},
): SkillInstructionDisplayMetadata | null {
  if (!path.startsWith("/skills/")) {
    return null;
  }

  const skillSlug = path.slice("/skills/".length).split("/")[0]?.trim();
  if (!skillSlug) {
    return null;
  }

  const skillPath = path.startsWith("/skills/") ? path : undefined;
  const skillFileName = skillPath?.split("/").at(-1)?.trim() || undefined;

  return {
    skillSlug,
    skillDisplayName:
      options.skillDisplayNamesBySlug?.get(skillSlug) ??
      formatSkillSlugForDisplay(skillSlug),
    ...(skillFileName ? { skillFileName } : {}),
    ...(skillPath ? { skillPath } : {}),
  };
}

function getSkillInstructionDisplayMetadataFromText(
  value: unknown,
): SkillInstructionDisplayMetadata | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/\/skills\/([^/\s"')\]}]+)(?:\/[^\s"')\]}]*)?/);
  const skillSlug = match?.[1]?.trim();
  const skillPath = match?.[0]?.replace(/[),.;:]+$/g, "");
  const skillFileName =
    skillPath?.startsWith(`/skills/${skillSlug}/`)
      ? skillPath.split("/").at(-1)?.trim()
      : undefined;
  return skillSlug
    ? {
        skillSlug,
        skillDisplayName: formatSkillSlugForDisplay(skillSlug),
        ...(skillFileName ? { skillFileName } : {}),
        ...(skillPath ? { skillPath } : {}),
      }
    : null;
}

export function getSkillInstructionDisplayMetadata(
  input: Record<string, unknown> | undefined,
  options: SkillInstructionDisplayOptions = {},
): SkillInstructionDisplayMetadata | null {
  if (!input) {
    return null;
  }

  const existingSlug = getPublicStringField(input, "skillSlug");
  const existingDisplayName = getPublicStringField(input, "skillDisplayName");
  const existingFileName = getPublicStringField(input, "skillFileName");
  const existingPath = getPublicStringField(input, "skillPath");
  if (existingSlug && existingDisplayName) {
    const pathMetadata = getSkillInstructionDisplayMetadataFromPath(
      resolveFilesystemPath(input),
      options,
    );
    return {
      skillSlug: existingSlug,
      skillDisplayName: existingDisplayName,
      ...(existingFileName || pathMetadata?.skillFileName
        ? {
            skillFileName: existingFileName ?? pathMetadata?.skillFileName,
          }
        : {}),
      ...(existingPath || pathMetadata?.skillPath
        ? { skillPath: existingPath ?? pathMetadata?.skillPath }
        : {}),
    };
  }

  return getSkillInstructionDisplayMetadataFromPath(
    resolveFilesystemPath(input),
    options,
  );
}

function getSkillInstructionTitle(
  action: "Reading" | "Read",
  input: Record<string, unknown>,
  options: SkillInstructionDisplayOptions = {},
) {
  const skillMetadata = getSkillInstructionDisplayMetadata(input, options);
  return skillMetadata
    ? `${action} ${skillMetadata.skillDisplayName} skill instructions`
    : `${action} skill instructions`;
}

function isFilesystemToolWithPresenter(toolName: string) {
  return Boolean(getFilesystemToolPresenter(toolName));
}

export function getFilesystemToolClientMetadata(
  toolName: string,
  input: Record<string, unknown>,
  options: SkillInstructionDisplayOptions = {},
): {
  filesystemScope: FilesystemToolScope;
  visibility: FilesystemToolVisibility;
} & Partial<SkillInstructionDisplayMetadata> {
  const scope = filesystemScope(input, toolName);
  return {
    filesystemScope: scope,
    visibility: scope === "skills" ? "internal_instruction" : "normal",
    ...(scope === "skills"
      ? (getSkillInstructionDisplayMetadata(input, options) ?? {})
      : {}),
  };
}

export function shouldRedactFilesystemToolForClient(
  toolName: string,
  input: Record<string, unknown> | undefined,
  options: SkillInstructionDisplayOptions = {},
) {
  return Boolean(
    input &&
      isFilesystemToolWithPresenter(toolName) &&
      getFilesystemToolClientMetadata(toolName, input, options).visibility ===
        "internal_instruction",
  );
}

export function sanitizeFilesystemToolInputForClient(
  toolName: string,
  input: Record<string, unknown>,
  options: SkillInstructionDisplayOptions = {},
) {
  if (!shouldRedactFilesystemToolForClient(toolName, input, options)) {
    return input;
  }
  return {
    filesystemScope: "skills" as const,
    redacted: true,
    visibility: "internal_instruction" as const,
    ...(getSkillInstructionDisplayMetadata(input, options) ?? {}),
  };
}

export function redactFilesystemToolOutputForClient(
  toolName: string,
  input: Record<string, unknown> | undefined,
  output: unknown,
  options: SkillInstructionDisplayOptions = {},
) {
  if (!shouldRedactFilesystemToolForClient(toolName, input, options)) {
    return output;
  }

  const metadata = getSkillInstructionDisplayMetadata(input, options);
  return {
    ...SKILL_INSTRUCTION_READ_OUTPUT,
    ...(metadata?.skillFileName
      ? { skillFileName: metadata.skillFileName }
      : {}),
    ...(metadata?.skillPath ? { skillPath: metadata.skillPath } : {}),
  };
}

function getTraceToolName(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function sanitizeFilesystemToolTraceRecordForClient(value: unknown) {
  const record = toObjectRecord(value);
  const tool = getTraceToolName(record?.tool);
  const input = toObjectRecord(record?.input);
  if (!record || !tool || !input) {
    return value;
  }

  return {
    ...record,
    input: sanitizeFilesystemToolInputForClient(tool, input),
    output: redactFilesystemToolOutputForClient(tool, input, record.output),
    ...(shouldRedactFilesystemToolForClient(tool, input)
      ? { title: getSkillInstructionTitle("Read", input) }
      : {}),
  };
}

function sanitizeThinkingStepForClient(value: unknown) {
  const record = toObjectRecord(value);
  const metadata = toObjectRecord(record?.metadata);
  const skillMetadata =
    getSkillInstructionDisplayMetadata(metadata ?? undefined) ??
    getSkillInstructionDisplayMetadataFromText(record?.title);
  if (
    !record ||
    (metadata?.visibility !== "internal_instruction" &&
      metadata?.filesystemScope !== "skills")
  ) {
    return value;
  }

  const sanitized: Record<string, unknown> = {
    ...record,
    items: [],
    title: skillMetadata
      ? `Read ${skillMetadata.skillDisplayName} skill instructions`
      : "Read skill instructions",
    metadata: {
      ...metadata,
      filesystemScope: "skills",
      visibility: "internal_instruction",
      redacted: true,
      ...(skillMetadata ?? {}),
    },
  };
  delete sanitized.detail;
  delete sanitized.description;
  return sanitized;
}

export function sanitizeThreadMessageMetadataForClient(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...metadata,
    ...(Array.isArray(metadata.toolCalls)
      ? {
          toolCalls: metadata.toolCalls.map(
            sanitizeFilesystemToolTraceRecordForClient,
          ),
        }
      : {}),
    ...(Array.isArray(metadata.traceParts)
      ? {
          traceParts: metadata.traceParts.map(
            sanitizeFilesystemToolTraceRecordForClient,
          ),
        }
      : {}),
    ...(Array.isArray(metadata.thinkingSteps)
      ? {
          thinkingSteps: metadata.thinkingSteps.map(
            sanitizeThinkingStepForClient,
          ),
        }
      : {}),
  };
}

export function extractWebFetchUrls(input: Record<string, unknown>) {
  const items = input.items;
  if (!Array.isArray(items)) {
    return [] as string[];
  }

  return items
    .map((item) => {
      const record = toObjectRecord(item);
      return typeof record?.url === "string" ? record.url.trim() : "";
    })
    .filter((url) => url.length > 0)
    .slice(0, 5);
}

const TOOL_INPUT_PREVIEW_FIELDS = [
  "query",
  "prompt",
  "url",
  "path",
  "pattern",
  "glob",
] as const;

export const GENERATED_IMAGE_ALT = "Generated image";

export function formatToolInputItems(
  input: Record<string, unknown>,
  toolName?: string,
) {
  if (toolName && shouldRedactFilesystemToolForClient(toolName, input)) {
    return [];
  }
  const entries = TOOL_INPUT_PREVIEW_FIELDS.map((key) => {
    const value = input[key];
    return typeof value === "string" && value.trim().length > 0
      ? `${key}: ${compactTraceText(value)}`
      : null;
  }).filter((item): item is string => item !== null);

  const items = input.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      const record = toObjectRecord(item);
      const url = typeof record?.url === "string" ? record.url.trim() : "";
      if (url) {
        entries.push(`url: ${compactTraceText(url)}`);
      }
    }
  }

  return entries.slice(0, 3);
}

export const FILESYSTEM_TOOL_PRESENTERS = {
  [AGENT_TOOL_NAMES.ls]: {
    start: {
      work: "Listing Workfiles",
      skills: "Listing selected skills",
      sources: "Listing selected sources",
    },
    end: {
      work: "Listed Workfiles",
      skills: "Listed selected skills",
      sources: "Listed selected sources",
    },
    describe: (input: { metadata: Record<string, unknown> }) =>
      typeof input.metadata.resultCount === "number"
        ? `Listed ${input.metadata.resultCount} entries.`
        : undefined,
  },
  [AGENT_TOOL_NAMES.glob]: {
    start: {
      work: "Finding matching Workfiles",
      skills: "Finding matching skill files",
      sources: "Finding matching sources",
    },
    end: {
      work: "Found matching Workfiles",
      skills: "Found matching skill files",
      sources: "Found matching sources",
    },
    describe: (input: { metadata: Record<string, unknown> }) =>
      typeof input.metadata.resultCount === "number"
        ? `Found ${input.metadata.resultCount} matching paths.`
        : undefined,
  },
  [AGENT_TOOL_NAMES.grep]: {
    start: {
      work: "Searching Workfiles",
      skills: "Searching skill instructions",
      sources: "Searching exact terms",
    },
    end: {
      work: "Searched Workfiles",
      skills: "Searched skill instructions",
      sources: "Searched exact terms",
    },
    describe: (input: { metadata: Record<string, unknown> }) =>
      typeof input.metadata.matchCount === "number"
        ? `Found ${input.metadata.matchCount} text matches.`
        : undefined,
  },
  [AGENT_TOOL_NAMES.readFile]: {
    start: {
      work: "Reading Workfile",
      skills: "Reading skill instructions",
      sources: "Reading source content",
    },
    end: {
      work: "Read Workfile",
      skills: "Read skill instructions",
      sources: "Read source content",
    },
    describe: (input: {
      metadata: Record<string, unknown>;
      scope: ReturnType<typeof filesystemScope>;
      input?: Record<string, unknown>;
    }) => {
      const inputLimit = toObjectRecord(input.input)?.limit;
      if (input.scope === "sources") {
        const lineLimit =
          typeof inputLimit === "number" && Number.isFinite(inputLimit)
            ? Math.max(1, Math.floor(inputLimit))
            : undefined;
        return lineLimit
          ? `Read up to ${lineLimit} source lines.`
          : "Read source content.";
      }
      if (typeof input.metadata.chunkCount === "number") {
        const noun = input.scope === "skills" ? "skill" : "Workfile";
        return `Read ${input.metadata.chunkCount} ${noun} ${
          input.metadata.chunkCount === 1 ? "chunk" : "chunks"
        }.`;
      }
      return undefined;
    },
  },
} as const;

export function getFilesystemToolPresenter(toolName: string) {
  return FILESYSTEM_TOOL_PRESENTERS[
    toolName as keyof typeof FILESYSTEM_TOOL_PRESENTERS
  ];
}

export function getFilesystemToolStartTitle(
  toolName: string,
  input: Record<string, unknown>,
  options: SkillInstructionDisplayOptions = {},
) {
  if (hasAgentToolCapability(toolName, "generated_image_artifact")) {
    return "Generating image";
  }
  if (hasAgentToolCapability(toolName, "presentation_artifact")) {
    return "Publishing deck";
  }
  const scope = filesystemScope(input, toolName);
  if (scope === "skills" && toolName === AGENT_TOOL_NAMES.readFile) {
    return getSkillInstructionTitle("Reading", input, options);
  }
  return getFilesystemToolPresenter(toolName)?.start[scope] ?? null;
}

export function getFilesystemToolEndTitle(
  toolName: string,
  input: Record<string, unknown>,
  output?: unknown,
  options: SkillInstructionDisplayOptions = {},
) {
  if (hasAgentToolCapability(toolName, "generated_image_artifact")) {
    return "Generated image";
  }
  if (hasAgentToolCapability(toolName, "presentation_artifact")) {
    if (isPresentationArtifactInputRequiredOutput(output)) {
      return "Deck content needed";
    }
    if (output !== undefined && !hasPresentationArtifactUrl(output)) {
      return "Deck publishing incomplete";
    }
    return "Published deck";
  }
  const scope = filesystemScope(input, toolName);
  if (scope === "skills" && toolName === AGENT_TOOL_NAMES.readFile) {
    return getSkillInstructionTitle("Read", input, options);
  }
  return getFilesystemToolPresenter(toolName)?.end[scope] ?? null;
}

export function extractGeneratedImageArtifacts(
  toolCalls: ToolCallTrace[],
): GeneratedImageArtifactReference[] {
  const seen = new Set<string>();
  return toolCalls
    .filter(
      (call) =>
        hasAgentToolCapability(call.tool, "generated_image_artifact") &&
        call.status === "completed" &&
        !call.error,
    )
    .map((call): GeneratedImageArtifactReference | null => {
      const artifactId =
        extractToolOutputField(call.output, "artifact_id") ?? "";
      const artifactUrl = extractToolOutputField(call.output, "artifact_url");
      const title =
        extractToolOutputField(call.output, "title") || GENERATED_IMAGE_ALT;

      return artifactUrl
        ? {
            artifactId: artifactId || null,
            artifactUrl,
            title,
            toolCallId: call.id,
          }
        : null;
    })
    .filter((artifact): artifact is GeneratedImageArtifactReference =>
      Boolean(artifact),
    )
    .filter((artifact) => {
      const key = artifact.artifactId ?? artifact.artifactUrl;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

export function isPresentationArtifactInputRequiredOutput(output: unknown) {
  if (output === undefined) {
    return false;
  }
  const type = extractToolOutputField(output, "type")?.toLowerCase().trim();
  const status = extractToolOutputField(output, "status")?.toLowerCase().trim();
  return (
    type === "presentation_artifact_input_required" ||
    status === "needs_content"
  );
}

export function hasPresentationArtifactUrl(output: unknown) {
  return Boolean(
    extractToolOutputField(output, "artifact_url") ??
      extractToolOutputField(output, "pptx_url") ??
      extractToolOutputField(output, "artifactUrl") ??
      extractToolOutputField(output, "pptxUrl"),
  );
}

export function normalizeToolOutputForObservability(
  toolName: string,
  output: unknown,
  input?: Record<string, unknown>,
) {
  const redactedOutput = redactFilesystemToolOutputForClient(
    toolName,
    input,
    output,
  );
  if (redactedOutput !== output) {
    return redactedOutput;
  }

  if (isAgentToolDomain(toolName, "web")) {
    return normalizeWebToolOutput(toolName, output);
  }

  if (isAgentToolDomain(toolName, "connector")) {
    return normalizeConnectorToolOutput(toolName, output);
  }

  if (!hasAgentToolCapability(toolName, "read_tool_output")) {
    return output;
  }

  const outputText = extractToolOutputText(output);
  if (outputText) {
    return { content: compactObservableToolContent(outputText) };
  }

  const record = toObjectRecord(output);
  if (typeof record?.error === "string") {
    return { error: compactObservableToolContent(record.error) };
  }

  return output;
}

function normalizeWebToolOutput(toolName: string, output: unknown) {
  if (!isAgentToolDomain(toolName, "web")) {
    return output;
  }

  const outputText = extractToolOutputText(output);
  if (!outputText) {
    return output;
  }

  const urls = [...outputText.matchAll(/url='([^']+)'/g)]
    .map((match) => match[1])
    .filter((url): url is string => typeof url === "string");
  const webResultMatches = outputText.match(/<web_result /g);
  const webPageMatches = outputText.match(/<web_page /g);
  const errorMatches = outputText.match(/<web_page [^>]* error=/g);
  const toolError = extractWebToolError(outputText);
  const pages = extractWebToolPages(outputText);

  return {
    ...(webResultMatches ? { resultCount: webResultMatches.length } : {}),
    ...(webPageMatches ? { pageCount: webPageMatches.length } : {}),
    ...(errorMatches || toolError
      ? { errorCount: (errorMatches?.length ?? 0) + (toolError ? 1 : 0) }
      : {}),
    ...(toolError ? { error: toolError.error, query: toolError.query } : {}),
    urlCount: urls.length,
    urls: urls.slice(0, 10),
    ...(pages.length > 0 ? { pages } : {}),
    truncated: outputText.includes("truncated='true'"),
  };
}

export function getWebToolStartTitle(toolName: string) {
  if (hasAgentToolCapability(toolName, "web_query")) {
    return "Searching the web";
  }
  if (hasAgentToolCapability(toolName, "web_page_fetch")) {
    return "Fetching web pages";
  }
  return null;
}

export function getWebToolEndTitle(toolName: string) {
  if (hasAgentToolCapability(toolName, "web_query")) {
    return "Searched the web";
  }
  if (hasAgentToolCapability(toolName, "web_page_fetch")) {
    return "Fetched web pages";
  }
  return null;
}

export function getWebToolInputMetadata(
  toolName: string,
  input: Record<string, unknown>,
) {
  if (hasAgentToolCapability(toolName, "web_query")) {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const fresh = input.fresh === true;
    return {
      ...(query ? { query } : {}),
      ...(fresh ? { fresh: true } : {}),
    };
  }

  if (hasAgentToolCapability(toolName, "web_page_fetch")) {
    const urls = extractWebFetchUrls(input);
    const fresh = input.fresh === true;
    return {
      urlCount: urls.length,
      ...(fresh ? { fresh: true } : {}),
    };
  }

  return {};
}

export function getWebToolMetadata(output: unknown) {
  const outputText = extractToolOutputText(output);
  const metadata: Record<string, unknown> = {};
  if (!outputText) {
    return metadata;
  }

  const webResultMatches = outputText.match(/<web_result /g);
  const webPageMatches = outputText.match(/<web_page /g);
  const toolErrorMatches = outputText.match(/<web_tool_error /g);
  if (webResultMatches) {
    metadata.resultCount = webResultMatches.length;
  }
  if (toolErrorMatches) {
    metadata.errorCount = toolErrorMatches.length;
  }
  if (webPageMatches) {
    metadata.resultCount = webPageMatches.length;
    metadata.pageCount = webPageMatches.length;
    const errorMatches = outputText.match(/<web_page [^>]* error=/g);
    if (errorMatches) {
      metadata.errorCount = errorMatches.length;
      metadata.successCount = Math.max(
        0,
        webPageMatches.length - errorMatches.length,
      );
    }
  }
  metadata.truncated = outputText.includes("truncated='true'");
  return metadata;
}

function extractWebToolError(outputText: string) {
  const match = outputText.match(/<web_tool_error\b([^>]*)>/);
  if (!match) {
    return null;
  }
  const attributes = extractXmlAttributes(match[1] ?? "");
  const error = attributes.error?.trim();
  if (!error) {
    return null;
  }
  const query = attributes.query?.trim();
  return {
    error,
    ...(query ? { query } : {}),
  };
}

export function getWebToolOutputError(output: unknown) {
  const record = toObjectRecord(output);
  if (
    record &&
    typeof record.error === "string" &&
    record.error.trim().length > 0
  ) {
    return record.error.trim();
  }
  const pages = Array.isArray(record?.pages) ? record.pages : [];
  if (pages.length > 0) {
    const pageErrors = pages
      .map((page) => {
        const pageRecord = toObjectRecord(page);
        const error = pageRecord?.error;
        return typeof error === "string" && error.trim().length > 0
          ? error.trim()
          : null;
      })
      .filter((error): error is string => error !== null);
    if (pageErrors.length === pages.length) {
      return pageErrors[0] ?? "Web tool failed.";
    }
  }

  const outputText = extractToolOutputText(output);
  if (!outputText) {
    return null;
  }

  return extractWebToolError(outputText)?.error ?? null;
}

export function getFilesystemToolOutputError(
  toolName: string,
  output: unknown,
) {
  if (!hasAgentToolCapability(toolName, "sandbox_execute")) {
    return null;
  }

  const outputRecord = toObjectRecord(output);
  const directError =
    typeof outputRecord?.error === "string" ? outputRecord.error.trim() : "";
  if (directError.length > 0) {
    return directError;
  }

  const structuredFailureCode =
    typeof outputRecord?.failureCode === "string"
      ? outputRecord.failureCode.trim()
      : typeof outputRecord?.errorCode === "string"
        ? outputRecord.errorCode.trim()
        : "";
  if (
    structuredFailureCode === "SANDBOX_EXECUTE_COMMAND_DENIED" ||
    structuredFailureCode === "SANDBOX_EXECUTE_CWD_DENIED" ||
    structuredFailureCode === "SANDBOX_EXECUTE_VFS_PATH_DENIED"
  ) {
    return structuredFailureCode;
  }

  const outputText = extractToolOutputText(output);
  const commandOutput =
    typeof outputRecord?.output === "string" ? outputRecord.output : "";
  const combinedOutputText = [outputText, commandOutput]
    .filter((item): item is string => Boolean(item))
    .join("\n");
  if (!combinedOutputText) {
    return null;
  }

  const deniedMatch = combinedOutputText.match(
    /(SANDBOX_EXECUTE_(?:COMMAND|CWD|VFS_PATH)_DENIED:[^\n]*)/u,
  );
  if (deniedMatch?.[1]) {
    return deniedMatch[1].trim();
  }

  if (
    typeof outputRecord?.exitCode === "number" &&
    Number.isFinite(outputRecord.exitCode) &&
    outputRecord.exitCode !== 0
  ) {
    return `Command failed with exit code ${outputRecord.exitCode}.`;
  }

  const exitMatch = combinedOutputText.match(
    /\[Command failed with exit code (-?\d+)\]/u,
  );
  return exitMatch?.[1]
    ? `Command failed with exit code ${exitMatch[1]}.`
    : null;
}

export function getFilesystemToolFailureMetadata(
  toolName: string,
  output: unknown,
) {
  if (!hasAgentToolCapability(toolName, "sandbox_execute")) {
    return {};
  }
  const record = toObjectRecord(output);
  if (!record) {
    const outputText = extractToolOutputText(output);
    return outputText
      ? extractExecuteFailureMetadataFromText(outputText)
      : {};
  }

  const commandFingerprint =
    typeof record.commandFingerprint === "string"
      ? record.commandFingerprint.trim()
      : undefined;
  const failureCode =
    typeof record.failureCode === "string"
      ? record.failureCode.trim()
      : typeof record.errorCode === "string"
        ? record.errorCode.trim()
        : undefined;
  const repeatCount =
    typeof record.repeatCount === "number" && Number.isFinite(record.repeatCount)
      ? record.repeatCount
      : undefined;
  const runId =
    typeof record.runId === "string" ? record.runId.trim() : undefined;
  const outputText = extractToolOutputText(output);
  const textMetadata = outputText
    ? extractExecuteFailureMetadataFromText(outputText)
    : {};

  return {
    ...textMetadata,
    ...(commandFingerprint ? { commandFingerprint } : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(repeatCount !== undefined ? { repeatCount } : {}),
    ...(runId ? { runId } : {}),
  };
}

function safeExecuteFailureMessage(outputText: string) {
  const firstLine = outputText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (
    firstLine?.startsWith("SANDBOX_EXECUTE_COMMAND_DENIED:") ||
    firstLine?.startsWith("SANDBOX_EXECUTE_CWD_DENIED:") ||
    firstLine?.startsWith("SANDBOX_EXECUTE_VFS_PATH_DENIED:")
  ) {
    return firstLine;
  }
  return undefined;
}

function safeExecuteFailureHint(outputText: string) {
  const match = outputText.match(/^Hint:\s+(.+)$/mu);
  return match?.[1]?.trim() || undefined;
}

function extractExecuteFailureMetadataFromText(outputText: string) {
  const diagnosticsMatch = outputText.match(/^Diagnostics:\s+(.+)$/mu);
  const fields = diagnosticsMatch?.[1]
    ? Object.fromEntries(
        [...diagnosticsMatch[1].matchAll(/([A-Za-z][A-Za-z0-9]*)=([^\s]+)/gu)]
          .map((match) => [match[1], match[2]] as const),
      )
    : {};
  const repeatCount = Number(fields.repeatCount);
  const failureMessage = safeExecuteFailureMessage(outputText);
  const failureHint = failureMessage
    ? safeExecuteFailureHint(outputText)
    : undefined;
  return {
    ...(failureMessage ? { failureMessage } : {}),
    ...(failureHint ? { failureHint } : {}),
    ...(fields.commandFingerprint
      ? { commandFingerprint: fields.commandFingerprint }
      : {}),
    ...(fields.failureCode ? { failureCode: fields.failureCode } : {}),
    ...(Number.isFinite(repeatCount) ? { repeatCount } : {}),
    ...(fields.runId ? { runId: fields.runId } : {}),
  };
}

function extractWebToolPages(outputText: string) {
  return [...outputText.matchAll(/<(web_result|web_page)\b([^>]*)>/g)]
    .map((match) => {
      const tagName = match[1];
      const attributesText = match[2] ?? "";
      const attributes = extractXmlAttributes(attributesText);
      const url = attributes.url?.trim();
      if (!url) {
        return null;
      }

      const rank = Number(attributes.rank);
      const wordCount = Number(attributes.word_count);
      const title = attributes.title?.trim();
      const error = attributes.error?.trim();
      return {
        url,
        ...(title ? { title } : {}),
        ...(Number.isFinite(rank) ? { rank } : {}),
        ...(attributes.id ? { citation: attributes.id } : {}),
        ...(Number.isFinite(wordCount) ? { wordCount } : {}),
        ...(error ? { error } : {}),
        ...(attributes.truncated === "true" ? { truncated: true } : {}),
        hasContent: tagName === "web_page" || Number.isFinite(wordCount),
      };
    })
    .filter((page): page is NonNullable<typeof page> => page !== null)
    .slice(0, 20);
}

function normalizeConnectorToolOutput(toolName: string, output: unknown) {
  const record = toObjectRecord(output);
  const outputText = extractToolOutputText(output);
  const parsedTextRecord = outputText ? parseJsonObject(outputText) : null;
  const publicRecord = parsedTextRecord ?? record;
  if (publicRecord?.type === "connector_tool_error") {
    return publicRecord;
  }
  if (publicRecord?.type === "tool_confirmation_request") {
    return sanitizeToolConfirmationForObservability(publicRecord);
  }

  const actionType = getPublicStringField(publicRecord, "actionType");
  const outputToolName =
    getPublicStringField(publicRecord, "toolName") ?? toolName;
  const title = getPublicStringField(publicRecord, "title");
  const url = getPublicStringField(publicRecord, "url");
  const pageId = getPublicStringField(publicRecord, "pageId");
  const query = getPublicStringField(publicRecord, "query");
  const resultCount =
    typeof publicRecord?.resultCount === "number" &&
    Number.isFinite(publicRecord.resultCount)
      ? publicRecord.resultCount
      : null;
  const pages = normalizeConnectorPageSummaries(publicRecord?.pages);
  const connectorType =
    getAgentToolConnectorType(toolName) ??
    getAgentToolConnectorType(outputToolName) ??
    "connector";
  return {
    type: "connector_tool_result",
    connector: connectorType,
    toolName: outputToolName,
    ...(actionType ? { actionType } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(pageId ? { pageId } : {}),
    ...(query ? { query } : {}),
    ...(resultCount !== null ? { resultCount } : {}),
    ...(pages.length > 0 ? { pages } : {}),
  };
}

function normalizeConnectorPageSummaries(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const record = toObjectRecord(item);
      if (!record) {
        return null;
      }
      const pageId =
        typeof record.pageId === "string" && record.pageId.trim().length > 0
          ? record.pageId.trim()
          : null;
      const title =
        typeof record.title === "string" && record.title.trim().length > 0
          ? record.title.trim()
          : null;
      const url =
        typeof record.url === "string" && record.url.trim().length > 0
          ? record.url.trim()
          : null;
      const lastEditedTime =
        typeof record.lastEditedTime === "string" &&
        record.lastEditedTime.trim().length > 0
          ? record.lastEditedTime.trim()
          : null;
      if (!pageId && !title && !url) {
        return null;
      }
      return {
        ...(pageId ? { pageId } : {}),
        ...(title ? { title } : {}),
        ...(url ? { url } : {}),
        ...(lastEditedTime ? { lastEditedTime } : {}),
      };
    })
    .filter((item): item is Record<string, string> => item !== null);
}

function sanitizeToolConfirmationForObservability(
  confirmation: Record<string, unknown>,
) {
  const preview = toObjectRecord(confirmation.preview);
  const sanitized = {
    ...confirmation,
    preview: preview
      ? Object.fromEntries(
          Object.entries(preview).filter(([key]) => key !== "requestJson"),
        )
      : confirmation.preview,
  } as Record<string, unknown>;
  delete sanitized.editableArgs;
  return sanitized;
}

export function getFilesystemToolMetadata(toolName: string, output: unknown) {
  const record = toObjectRecord(output);
  const metadata: Record<string, unknown> = {};

  if (record?.redacted === true && record.type === "skill_instruction_read") {
    metadata.redacted = true;
    metadata.visibility = "internal_instruction";
    metadata.filesystemScope = "skills";
    return metadata;
  }

  if (hasAgentToolCapability(toolName, "generated_image_artifact")) {
    const outputText = extractToolOutputText(output) ?? "";
    const artifactId = outputText.match(/artifact_id:\s*(\S+)/)?.[1];
    const artifactUrl = outputText.match(/artifact_url:\s*(\S+)/)?.[1];
    if (artifactId) {
      metadata.artifactId = artifactId;
    }
    if (artifactUrl) {
      metadata.artifactUrl = artifactUrl;
    }
    return metadata;
  }

  if (hasAgentToolCapability(toolName, "presentation_artifact")) {
    const artifactId = extractToolOutputField(output, "artifact_id");
    const pptxUrl =
      extractToolOutputField(output, "artifact_url") ??
      extractToolOutputField(output, "pptx_url");
    const title = extractToolOutputField(output, "title");
    const resultType = extractToolOutputField(output, "type");
    const status = extractToolOutputField(output, "status");
    if (artifactId) {
      metadata.artifactId = artifactId;
    }
    if (pptxUrl) {
      metadata.artifactUrl = pptxUrl;
    }
    if (title) {
      metadata.title = title;
    }
    if (resultType) {
      metadata.resultType = resultType;
    }
    if (status) {
      metadata.status = status;
    }
    return metadata;
  }

  if (record && Array.isArray(record.files)) {
    metadata.resultCount = record.files.length;
  }
  if (record && Array.isArray(record.matches)) {
    metadata.matchCount = record.matches.length;
  }
  const outputText = extractToolOutputText(output);
  if (outputText) {
    const chunkMatches = outputText.match(/--- chunk |^Chunk:/gm);
    if (chunkMatches && chunkMatches.length > 0) {
      metadata.chunkCount = chunkMatches.length;
    }
    metadata.truncated = outputText.includes("Output truncated.");
  }

  if (
    hasAgentToolCapability(toolName, "read_tool_output") &&
    metadata.chunkCount === undefined
  ) {
    metadata.chunkCount = 1;
  }

  return metadata;
}

export function getFilesystemToolDescription(
  toolName: string,
  metadata: Record<string, unknown>,
  input?: Record<string, unknown>,
) {
  const scope = input ? filesystemScope(input, toolName) : "sources";
  if (hasAgentToolCapability(toolName, "generated_image_artifact")) {
    return "Created an image artifact.";
  }
  if (hasAgentToolCapability(toolName, "presentation_artifact")) {
    if (
      metadata.resultType === "presentation_artifact_input_required" ||
      metadata.status === "needs_content"
    ) {
      return "The deck tool needs explicit slide content before it can create an artifact.";
    }
    if (!metadata.artifactUrl) {
      return "The deck tool completed without returning an artifact URL.";
    }
    return "Created a presentation artifact.";
  }
  return getFilesystemToolPresenter(toolName)?.describe({
    metadata,
    scope,
    input,
  });
}

function getConnectorToolErrorRecord(output: unknown) {
  const record = toObjectRecord(output);
  if (record?.type === "connector_tool_error") {
    return record;
  }

  const outputText = extractToolOutputText(output);
  if (!outputText) {
    return null;
  }
  try {
    const parsed = JSON.parse(outputText);
    const parsedRecord = toObjectRecord(parsed);
    return parsedRecord?.type === "connector_tool_error" ? parsedRecord : null;
  } catch {
    return null;
  }
}

export function getConnectorToolOutputError(output: unknown) {
  const record = getConnectorToolErrorRecord(output);
  if (
    record &&
    typeof record.message === "string" &&
    record.message.trim().length > 0
  ) {
    return record.message.trim();
  }
  return null;
}

export function getConnectorToolOutputContentError(output: unknown) {
  const record = getConnectorToolErrorRecord(output);
  const outputText = extractToolOutputText(output) ?? "";
  if (record?.code !== "CONNECTOR_ACTION_NOT_APPROVED") {
    if (
      !outputText.includes("CONNECTOR_ACTION_NOT_APPROVED") &&
      !outputText.includes(
        "Connector action must be approved before execution",
      ) &&
      !outputText.includes(
        "Approved action was not found for this resumed tool call",
      )
    ) {
      return null;
    }
  }
  return new ContentError(
    409,
    "CONNECTOR_ACTION_APPROVAL_MISMATCH",
    "The approved connector action could not be matched during HITL replay. Please retry the latest confirmation.",
  );
}

export function getConnectorToolErrorTextContentError(errorText: string) {
  if (
    !errorText.includes("CONNECTOR_ACTION_NOT_APPROVED") &&
    !errorText.includes("Connector action must be approved before execution") &&
    !errorText.includes(
      "Approved action was not found for this resumed tool call",
    )
  ) {
    return null;
  }
  return new ContentError(
    409,
    "CONNECTOR_ACTION_APPROVAL_MISMATCH",
    "The approved connector action could not be matched during HITL replay. Please retry the latest confirmation.",
  );
}

import type { ToolCallTrace } from "../..";

type GeneratedImageArtifactReference = {
  artifactId: string | null;
  title: string;
  artifactUrl: string;
  toolCallId?: string;
};

export function extractToolPayloadInput(toolPayload: Record<string, unknown>) {
  for (const candidate of [toolPayload.input, toolPayload.args]) {
    const normalized = normalizeToolInput(candidate);
    if (Object.keys(normalized).length > 0) {
      return normalized;
    }
  }

  const data = toObjectRecord(toolPayload.data);
  if (!data) {
    return {};
  }

  for (const candidate of [data.input, data.args]) {
    const normalized = normalizeToolInput(candidate);
    if (Object.keys(normalized).length > 0) {
      return normalized;
    }
  }

  return {};
}
