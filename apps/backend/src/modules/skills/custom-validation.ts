import { createHash } from "node:crypto";
import path from "node:path";
import type { SkillManifestJson } from "@sourceweft/db";
import {
  agentToolRequiredForModelKind,
  getAgentToolConfigKeys,
  isConfigurableAgentTool,
  isSkillDeclarableAgentTool,
} from "@sourceweft/agent-tool-registry";
import { getSourceWeftFrontmatter, parseSkillFrontmatter } from "./frontmatter";

export const CUSTOM_SKILL_LIMITS = {
  skillMdBytes: 256 * 1024,
  fileBytes: 256 * 1024,
  bundleBytes: 1024 * 1024,
  fileCount: 50,
};

const ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);
const COMMAND_FILE_PATTERN = /^commands\/.+\.md$/i;
const MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

export type CustomSkillFileInput = {
  path: string;
  contentText: string;
  mimeType?: string | null;
};

export type ValidatedCustomSkillFile = {
  path: string;
  contentText: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
};

export type ValidatedCustomSkillBundle = {
  name: string;
  displayName: string;
  description: string;
  version: string;
  files: ValidatedCustomSkillFile[];
  contentHash: string;
  manifestJson: SkillManifestJson;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function validateSkillName(name: string) {
  return (
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) && !name.includes("--")
  );
}

function validateDisplayName(name: string) {
  return name.trim().length > 0 && name.length <= 128;
}

function normalizeCategory(value: unknown) {
  return typeof value === "string" && validateSkillName(value) ? value : null;
}

function normalizeCapability(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return /^[a-z0-9_.:-]{1,128}$/.test(normalized) ? normalized : null;
}

function normalizeCapabilities(
  value: unknown,
): SkillManifestJson["capabilities"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const requiredValue = record.required;
  const optionalValue = record.optional;
  const required = Array.isArray(requiredValue)
    ? requiredValue
        .map(normalizeCapability)
        .filter((capability): capability is string => Boolean(capability))
    : [];
  const optional = Array.isArray(optionalValue)
    ? optionalValue
        .map(normalizeCapability)
        .filter((capability): capability is string => Boolean(capability))
    : [];

  if (
    (Array.isArray(requiredValue) &&
      required.length !== requiredValue.length) ||
    (Array.isArray(optionalValue) && optional.length !== optionalValue.length)
  ) {
    throw new Error("Custom skill manifest capabilities are invalid");
  }

  const capabilities: NonNullable<SkillManifestJson["capabilities"]> = {};
  if (required.length > 0) {
    capabilities.required = Array.from(new Set(required));
  }
  if (optional.length > 0) {
    capabilities.optional = Array.from(new Set(optional));
  }
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function normalizeModelAlias(value: unknown) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 512
    ? value.trim()
    : null;
}

function normalizeModels(value: unknown): SkillManifestJson["models"] {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Custom skill manifest models are invalid");
  }
  const record = value as Record<string, unknown>;
  const models: NonNullable<SkillManifestJson["models"]> = {};
  const chat = normalizeModelAlias(record.chat);
  const image = normalizeModelAlias(record.image);
  const vision = normalizeModelAlias(record.vision);
  if (chat) models.chat = chat;
  if (image) models.image = image;
  if (vision) models.vision = vision;

  const knownKeys = new Set(["chat", "image", "vision"]);
  if (
    Object.keys(record).some((key) => !knownKeys.has(key)) ||
    (record.chat !== undefined && !chat) ||
    (record.image !== undefined && !image) ||
    (record.vision !== undefined && !vision)
  ) {
    throw new Error("Custom skill manifest models are invalid");
  }

  return Object.keys(models).length > 0 ? models : undefined;
}

function normalizeTools(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Custom skill manifest tools are invalid");
  }
  const tools = value.map((item) =>
    typeof item === "string" ? item.trim() : "",
  );
  if (tools.some((toolName) => !isSkillDeclarableAgentTool(toolName))) {
    throw new Error("Custom skill manifest tools are invalid");
  }
  return Array.from(new Set(tools));
}

function validateToolDefaultConfig(toolName: string, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Custom skill manifest defaultConfig is invalid");
  }
  const configKeys = getAgentToolConfigKeys(toolName);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !configKeys.includes(key))) {
    throw new Error("Custom skill manifest defaultConfig is invalid");
  }
}

function normalizeDefaultConfig(value: unknown, tools: string[] | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Custom skill manifest defaultConfig is invalid");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!isSkillDeclarableAgentTool(key)) {
      throw new Error("Custom skill manifest defaultConfig is invalid");
    }
    if (!isConfigurableAgentTool(key)) {
      throw new Error("Custom skill manifest defaultConfig is invalid");
    }
    if (!tools?.includes(key)) {
      throw new Error(
        "Custom skill manifest defaultConfig requires matching tools",
      );
    }
    if (getAgentToolConfigKeys(key).length > 0) {
      validateToolDefaultConfig(key, record[key]);
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function isSkillOptionValue(
  value: unknown,
): value is string | number | boolean {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

function isSkillOptionValueType(
  value: unknown,
): value is "string" | "number" | "boolean" {
  return value === "string" || value === "number" || value === "boolean";
}

function validateSkillOptionValue(
  value: unknown,
  valueType: "string" | "number" | "boolean",
): value is string | number | boolean {
  return isSkillOptionValue(value) && typeof value === valueType;
}

function isSafeOptionPath(path: string) {
  return path
    .split(".")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "__proto__" &&
        segment !== "constructor" &&
        segment !== "prototype",
    );
}

function validateSkillOptionTarget(input: {
  target: Record<string, unknown>;
  tools: string[] | undefined;
}) {
  const toolName =
    typeof input.target.toolName === "string" ? input.target.toolName : "";
  const path = typeof input.target.path === "string" ? input.target.path : "";
  const segments = path.split(".");
  if (!toolName) {
    if (
      !path ||
      !isSafeOptionPath(path) ||
      segments.length !== 2 ||
      segments[0] !== "config"
    ) {
      throw new Error("Custom skill manifest options are invalid");
    }
    return { path };
  }
  if (
    !path ||
    !isSkillDeclarableAgentTool(toolName) ||
    !isConfigurableAgentTool(toolName) ||
    !input.tools?.includes(toolName) ||
    !isSafeOptionPath(path)
  ) {
    throw new Error("Custom skill manifest options are invalid");
  }
  if (segments.length !== 2 || segments[0] !== "config") {
    throw new Error("Custom skill manifest options are invalid");
  }
  const configKeys = getAgentToolConfigKeys(toolName);
  if (!configKeys.includes(segments[1] ?? "")) {
    throw new Error("Custom skill manifest options are invalid");
  }
  return { path, toolName };
}

function normalizeSkillOptions(
  value: unknown,
  tools: string[] | undefined,
): SkillManifestJson["options"] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Custom skill manifest options are invalid");
  }
  const seenIds = new Set<string>();
  const options: NonNullable<SkillManifestJson["options"]> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Custom skill manifest options are invalid");
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const description =
      typeof record.description === "string"
        ? record.description.trim()
        : undefined;
    if (
      !/^[a-z][A-Za-z0-9_.:-]*$/u.test(id) ||
      seenIds.has(id) ||
      title.length === 0 ||
      title.length > 128 ||
      (description !== undefined && description.length > 1024) ||
      !isSkillOptionValueType(record.valueType) ||
      !record.target ||
      typeof record.target !== "object" ||
      Array.isArray(record.target)
    ) {
      throw new Error("Custom skill manifest options are invalid");
    }
    const valueType = record.valueType;
    const defaultValue = record.defaultValue;
    let normalizedDefaultValue: string | number | boolean | undefined;
    if (defaultValue !== undefined) {
      if (!validateSkillOptionValue(defaultValue, valueType)) {
        throw new Error("Custom skill manifest options are invalid");
      }
      normalizedDefaultValue = defaultValue;
    }
    if (!Array.isArray(record.values)) {
      throw new Error("Custom skill manifest options are invalid");
    }
    const values = record.values.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Custom skill manifest options are invalid");
      }
      const valueRecord = entry as Record<string, unknown>;
      if (!validateSkillOptionValue(valueRecord.value, valueType)) {
        throw new Error("Custom skill manifest options are invalid");
      }
      const label =
        typeof valueRecord.label === "string"
          ? valueRecord.label.trim()
          : undefined;
      if (label !== undefined && (label.length === 0 || label.length > 128)) {
        throw new Error("Custom skill manifest options are invalid");
      }
      return {
        value: valueRecord.value,
        ...(label ? { label } : {}),
      };
    });
    seenIds.add(id);
    options.push({
      id,
      title,
      ...(description ? { description } : {}),
      valueType,
      ...(normalizedDefaultValue !== undefined
        ? { defaultValue: normalizedDefaultValue }
        : {}),
      target: validateSkillOptionTarget({
        target: record.target as Record<string, unknown>,
        tools,
      }),
      values,
    });
  }
  return options.length > 0 ? options : undefined;
}

function normalizeSlash(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error("Custom skill manifest slash is invalid");
  }
  return value;
}

function normalizeSlashConfig(
  value: unknown,
): SkillManifestJson["slashConfig"] {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Custom skill manifest slashConfig is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "enabled") ||
    (record.enabled !== undefined && typeof record.enabled !== "boolean")
  ) {
    throw new Error("Custom skill manifest slashConfig is invalid");
  }
  return record.enabled === undefined ? {} : { enabled: record.enabled };
}

function firstJsonObject(files: ValidatedCustomSkillFile[]) {
  const manifestFile = files.find((file) => file.path === "skill.json");
  if (!manifestFile) {
    return null;
  }
  try {
    const parsed = JSON.parse(manifestFile.contentText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("skill.json must contain an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "skill.json is invalid JSON",
    );
  }
}

function normalizeSkillFilePath(inputPath: string) {
  const normalized = path.posix.normalize(inputPath.replace(/\\/g, "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Invalid custom skill file path '${inputPath}'`);
  }
  if (normalized.startsWith("scripts/") || normalized.includes("/scripts/")) {
    throw new Error(`Custom skills cannot include scripts: '${inputPath}'`);
  }
  if (COMMAND_FILE_PATTERN.test(normalized)) {
    throw new Error(`Custom skills cannot include commands: '${inputPath}'`);
  }
  const ext = path.posix.extname(normalized).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Custom skill file type is not allowed: '${inputPath}'`);
  }
  return normalized;
}

export function validateCustomSkillFileInput(
  file: CustomSkillFileInput,
): ValidatedCustomSkillFile {
  const normalizedPath = normalizeSkillFilePath(file.path);
  const sizeBytes = Buffer.byteLength(file.contentText, "utf8");
  if (sizeBytes > CUSTOM_SKILL_LIMITS.fileBytes) {
    throw new Error(`Custom skill file '${normalizedPath}' exceeds size limit`);
  }
  const ext = path.posix.extname(normalizedPath).toLowerCase();
  return {
    path: normalizedPath,
    contentText: file.contentText,
    mimeType: MIME_BY_EXTENSION[ext] ?? "text/plain",
    sizeBytes,
    contentHash: sha256(file.contentText),
  };
}

export function hashCustomSkillFiles(
  files: Array<Pick<ValidatedCustomSkillFile, "path" | "contentHash">>,
) {
  return sha256(
    [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => `${file.path}\0${file.contentHash}`)
      .join("\n"),
  );
}

export function validateCustomSkillBundle(input: {
  files: CustomSkillFileInput[];
}): ValidatedCustomSkillBundle {
  if (input.files.length === 0) {
    throw new Error("Custom skill bundle must include SKILL.md");
  }
  if (input.files.length > CUSTOM_SKILL_LIMITS.fileCount) {
    throw new Error(
      `Custom skill bundle exceeds ${CUSTOM_SKILL_LIMITS.fileCount} files`,
    );
  }

  const seen = new Set<string>();
  const files = input.files
    .map((file) => {
      const validated = validateCustomSkillFileInput(file);
      if (seen.has(validated.path)) {
        throw new Error(`Duplicate custom skill file path '${validated.path}'`);
      }
      seen.add(validated.path);
      return validated;
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (!skillMd) {
    throw new Error("Custom skill bundle must include SKILL.md");
  }
  if (skillMd.sizeBytes > CUSTOM_SKILL_LIMITS.skillMdBytes) {
    throw new Error("Custom skill SKILL.md exceeds size limit");
  }

  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (totalBytes > CUSTOM_SKILL_LIMITS.bundleBytes) {
    throw new Error("Custom skill bundle exceeds total size limit");
  }

  const frontmatter = parseSkillFrontmatter(skillMd.contentText);
  const sourceweft = getSourceWeftFrontmatter(frontmatter);
  if (Object.keys(sourceweft).length > 0) {
    throw new Error(
      "Custom SKILL.md must not contain SourceWeft metadata; use skill.json",
    );
  }
  const skillJson = firstJsonObject(files);
  const slug = String(frontmatter.name ?? skillJson?.slug ?? "").trim();
  const displayName = String(
    skillJson?.displayName ?? slug,
  ).trim();
  const version = String(skillJson?.version ?? "0.1.0").trim();
  const description = String(
    frontmatter.description ?? skillJson?.description ?? "",
  ).trim();
  const visibility = String(skillJson?.visibility ?? "workspace").trim();
  const categoriesValue = skillJson?.categories;
  const categories = Array.isArray(categoriesValue)
    ? categoriesValue
        .map(normalizeCategory)
        .filter((category): category is string => Boolean(category))
    : [];
  const capabilities = normalizeCapabilities(skillJson?.capabilities);
  const models = normalizeModels(skillJson?.models);
  const tools = normalizeTools(skillJson?.tools);
  const defaultConfig = normalizeDefaultConfig(
    skillJson?.defaultConfig,
    tools,
  );
  const options = normalizeSkillOptions(skillJson?.options, tools);
  const slash = normalizeSlash(skillJson?.slash);
  const slashConfig = normalizeSlashConfig(skillJson?.slashConfig);

  if (!validateSkillName(slug)) {
    throw new Error("Custom skill manifest slug is invalid");
  }
  if (!validateDisplayName(displayName)) {
    throw new Error("Custom skill manifest displayName is invalid");
  }
  if (!version || version.length > 64) {
    throw new Error("Custom skill manifest version is invalid");
  }
  if (visibility !== "workspace" && visibility !== "team") {
    throw new Error("Custom skill manifest visibility is invalid");
  }
  if (
    Array.isArray(categoriesValue) &&
    categories.length !== categoriesValue.length
  ) {
    throw new Error("Custom skill manifest categories are invalid");
  }
  if (!description || description.length > 1024) {
    throw new Error("Custom skill manifest description is invalid");
  }
  const imageTool = agentToolRequiredForModelKind("image");
  if (models?.image && imageTool && !tools?.includes(imageTool)) {
    throw new Error(
      `Custom skill manifest models.image requires ${imageTool} tool`,
    );
  }

  const contentHash = hashCustomSkillFiles(files);
  const manifestJson: SkillManifestJson = {
    slug,
    displayName,
    version,
    description,
    visibility,
    categories: Array.from(new Set(categories)),
  };
  if (capabilities) {
    manifestJson.capabilities = capabilities;
  }
  if (defaultConfig) {
    manifestJson.defaultConfig = defaultConfig;
  }
  if (models) {
    manifestJson.models = models;
  }
  if (tools) {
    manifestJson.tools = tools;
  }
  if (options) {
    manifestJson.options = options;
  }
  if (slash !== undefined) {
    manifestJson.slash = slash;
  }
  if (slashConfig) {
    manifestJson.slashConfig = slashConfig;
  }

  return {
    name: slug,
    displayName,
    description,
    version,
    files,
    contentHash,
    manifestJson,
  };
}
