import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillManifestJson } from "../../../shared/db/schema";
import {
  agentToolRequiredForModelKind,
  getAgentToolConfigKeys,
  isConfigurableAgentTool,
  isSkillDeclarableAgentTool,
} from "../agent/tool-registry";
import { parseSkillCommands, publicSkillCommands } from "./commands";

export type SkillBundleFile = {
  path: string;
  contentText: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
};

export type BuiltinSkillManifest = {
  slug: string;
  displayName: string;
  description: string;
  visibility: "public" | "restricted";
  categories: string[];
  version: string;
  manifestJson: SkillManifestJson;
  storagePointer: string;
  contentHash: string;
};

export type BuiltinSkillBundle = {
  slug: string;
  version: string;
  description: string;
  files: SkillBundleFile[];
};

type ParsedBuiltinManifest = {
  slug: string;
  displayName: string;
  description: string;
  visibility: "public" | "restricted";
  categories: string[];
  version: string;
  models?: SkillManifestJson["models"];
  tools?: string[];
  slash?: boolean;
  slashConfig?: SkillManifestJson["slashConfig"];
  defaultConfig?: Record<string, unknown>;
};

const builtinRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "builtin",
);

const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

let builtinSkillsCache: BuiltinSkillManifest[] | null = null;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function validateSkillName(name: string) {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) &&
    !name.includes("--");
}

function normalizeCategory(value: unknown) {
  return typeof value === "string" && validateSkillName(value) ? value : null;
}

function normalizeModelAlias(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512
    ? value.trim()
    : null;
}

function normalizeModels(value: unknown): SkillManifestJson["models"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
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
    throw new Error("skill.json models are invalid");
  }
  return Object.keys(models).length > 0 ? models : undefined;
}

function normalizeTools(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("skill.json tools must be an array");
  }
  const tools = value.map((item) =>
    typeof item === "string" ? item.trim() : "",
  );
  if (tools.some((toolName) => !isSkillDeclarableAgentTool(toolName))) {
    throw new Error("skill.json references an unknown tool");
  }
  return Array.from(new Set(tools));
}

function normalizeDefaultConfig(value: unknown, tools: string[] | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("skill.json defaultConfig must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!isSkillDeclarableAgentTool(key)) {
      throw new Error("skill.json defaultConfig references an unknown tool");
    }
    if (!isConfigurableAgentTool(key)) {
      throw new Error(`skill.json defaultConfig is not supported for '${key}'`);
    }
    if (!tools?.includes(key)) {
      throw new Error(`skill.json defaultConfig '${key}' must also be declared in tools`);
    }
    const configKeys = getAgentToolConfigKeys(key);
    if (configKeys.length > 0) {
      const config = record[key];
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error(`skill.json defaultConfig ${key} is invalid`);
      }
      if (
        Object.keys(config as Record<string, unknown>).some(
          (configKey) => !configKeys.includes(configKey),
        )
      ) {
        throw new Error(`skill.json defaultConfig ${key} is invalid`);
      }
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function normalizeSlash(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error("skill.json slash must be a boolean");
  }
  return value;
}

function normalizeSlashConfig(value: unknown): SkillManifestJson["slashConfig"] {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("skill.json slashConfig must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "enabled") ||
    (record.enabled !== undefined && typeof record.enabled !== "boolean")
  ) {
    throw new Error("skill.json slashConfig is invalid");
  }
  return record.enabled === undefined ? {} : { enabled: record.enabled };
}

function parseBuiltinManifest(value: unknown, source: string): ParsedBuiltinManifest {
  assertRecord(value, source);
  const slug = value.slug;
  const displayName = value.displayName;
  const description = value.description;
  const visibility = value.visibility;
  const categories = value.categories;
  const version = value.version;
  const tools = normalizeTools(value.tools);
  const models = normalizeModels(value.models);
  const defaultConfig = normalizeDefaultConfig(value.defaultConfig, tools);
  const slash = normalizeSlash(value.slash);
  const slashConfig = normalizeSlashConfig(value.slashConfig);

  if (typeof slug !== "string" || !validateSkillName(slug)) {
    throw new Error(`${source} slug is invalid`);
  }
  if (typeof displayName !== "string" || displayName.trim().length === 0 || displayName.length > 128) {
    throw new Error(`${source} displayName is invalid`);
  }
  if (typeof description !== "string" || description.trim().length === 0 || description.length > 1024) {
    throw new Error(`${source} description is invalid`);
  }
  if (visibility !== "public" && visibility !== "restricted") {
    throw new Error(`${source} visibility is invalid`);
  }
  if (!Array.isArray(categories)) {
    throw new Error(`${source} categories must be an array`);
  }
  const normalizedCategories = categories
    .map(normalizeCategory)
    .filter((category): category is string => Boolean(category));
  if (normalizedCategories.length !== categories.length) {
    throw new Error(`${source} categories are invalid`);
  }
  if (typeof version !== "string" || version.trim().length === 0 || version.length > 64) {
    throw new Error(`${source} version is invalid`);
  }
  const imageTool = agentToolRequiredForModelKind("image");
  if (models?.image && imageTool && !tools?.includes(imageTool)) {
    throw new Error(`${source} models.image requires ${imageTool} tool`);
  }

  return {
    slug,
    displayName: displayName.trim(),
    description: description.trim(),
    visibility,
    categories: Array.from(new Set(normalizedCategories)),
    version: version.trim(),
    ...(models ? { models } : {}),
    ...(tools ? { tools } : {}),
    ...(slash !== undefined ? { slash } : {}),
    ...(slashConfig ? { slashConfig } : {}),
    ...(defaultConfig ? { defaultConfig } : {}),
  };
}

function normalizeStoragePointer(inputPath: string) {
  const normalized = path.posix.normalize(inputPath.replace(/\\/g, "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Invalid builtin skill storage pointer '${inputPath}'`);
  }
  return normalized;
}

function slugFromStoragePointer(storagePointer: string) {
  const normalized = normalizeStoragePointer(storagePointer);
  if (!normalized.includes("/")) {
    return normalized;
  }

  const [slug, legacySegment] = normalized.split("/");
  return slug && legacySegment === "versions" ? slug : null;
}

function parseFrontmatter(content: string) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

function normalizeRelativePath(baseDir: string, filePath: string) {
  return path.relative(baseDir, filePath).split(path.sep).join("/");
}

async function collectFiles(baseDir: string, currentDir = baseDir): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(baseDir, fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function collectSkillFiles(skillDir: string) {
  const normalizedSkillDir = path.resolve(skillDir);
  return Promise.all(
    (await collectFiles(normalizedSkillDir))
      .filter((filePath) => normalizeRelativePath(normalizedSkillDir, filePath) !== "skill.json")
      .map(async (filePath) => {
        const contentText = await readFile(filePath, "utf8");
        const relativePath = normalizeRelativePath(normalizedSkillDir, filePath);
        const ext = path.extname(relativePath).toLowerCase();
        return {
          path: relativePath,
          contentText,
          mimeType: TEXT_MIME_BY_EXTENSION[ext] ?? "text/plain",
          sizeBytes: Buffer.byteLength(contentText, "utf8"),
          contentHash: sha256(contentText),
        };
      }),
  );
}

function hashFiles(files: Array<Pick<SkillBundleFile, "path" | "contentHash">>) {
  return sha256(
    [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => `${file.path}\0${file.contentHash}`)
      .join("\n"),
  );
}

async function loadBuiltinSkillsFromDisk(): Promise<BuiltinSkillManifest[]> {
  if (builtinSkillsCache) {
    return builtinSkillsCache;
  }

  const entries = await readdir(builtinRoot, { withFileTypes: true });
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const skillDir = path.join(builtinRoot, entry.name);
        const manifestPath = path.join(skillDir, "skill.json");
        const content = await readFile(manifestPath, "utf8");
        const parsed = parseBuiltinManifest(JSON.parse(content) as unknown, manifestPath);
        if (parsed.slug !== entry.name) {
          throw new Error(`${manifestPath} slug must match folder name`);
        }

        const files = await collectSkillFiles(skillDir);
        const skillMd = files.find((file) => file.path === "SKILL.md");
        if (!skillMd) {
          throw new Error(`Builtin skill '${parsed.slug}' missing SKILL.md`);
        }
        const frontmatter = parseFrontmatter(skillMd.contentText);
        if (frontmatter.name !== parsed.slug) {
          throw new Error(`Builtin skill '${parsed.slug}' frontmatter.name must be '${parsed.slug}'`);
        }
        if (!frontmatter.description || frontmatter.description.length > 1024) {
          throw new Error(`Builtin skill '${parsed.slug}' frontmatter.description is invalid`);
        }
        const manifestJson: SkillManifestJson = {
          slug: parsed.slug,
          displayName: parsed.displayName,
          version: parsed.version,
          description: parsed.description,
          visibility: parsed.visibility,
          categories: parsed.categories,
        };
        if (parsed.models) {
          manifestJson.models = parsed.models;
        }
        if (parsed.tools) {
          manifestJson.tools = parsed.tools;
        }
        if (parsed.slash !== undefined) {
          manifestJson.slash = parsed.slash;
        }
        if (parsed.slashConfig) {
          manifestJson.slashConfig = parsed.slashConfig;
        }
        if (parsed.defaultConfig) {
          manifestJson.defaultConfig = parsed.defaultConfig;
        }
        const commands = parseSkillCommands({
          files,
          skillSlug: parsed.slug,
        });
        const publicCommands = publicSkillCommands(commands);
        if (publicCommands) {
          manifestJson.commands = publicCommands;
        }

        return {
          slug: parsed.slug,
          displayName: parsed.displayName,
          description: parsed.description,
          visibility: parsed.visibility,
          categories: parsed.categories,
          version: parsed.version,
          manifestJson,
          storagePointer: parsed.slug,
          contentHash: hashFiles(files),
        };
      }),
  );

  const sortedSkills = skills.sort((a, b) => a.displayName.localeCompare(b.displayName));
  builtinSkillsCache = sortedSkills;
  return sortedSkills;
}

export async function listBuiltinSkills() {
  return [...await loadBuiltinSkillsFromDisk()];
}

export async function getBuiltinSkillBySlug(slug: string) {
  return (await loadBuiltinSkillsFromDisk()).find((skill) => skill.slug === slug) ?? null;
}

export async function readBuiltinSkillFile(storagePointer: string, filePath: string) {
  const file = (await loadBuiltinSkillBundle(storagePointer))?.files.find((item) => item.path === filePath);
  return file ?? null;
}

export async function validateBuiltinSkills() {
  const seenSlugs = new Set<string>();
  for (const skill of await listBuiltinSkills()) {
    if (seenSlugs.has(skill.slug)) {
      throw new Error(`Duplicate builtin skill slug '${skill.slug}'`);
    }
    seenSlugs.add(skill.slug);
  }
}

export async function loadBuiltinSkillBundle(storagePointer: string): Promise<BuiltinSkillBundle | null> {
  const slug = slugFromStoragePointer(storagePointer);
  if (!slug) {
    return null;
  }
  const skill = await getBuiltinSkillBySlug(slug);
  if (!skill) {
    return null;
  }
  const skillDir = path.join(builtinRoot, skill.slug);
  const files = await collectSkillFiles(skillDir);
  return {
    slug: skill.slug,
    version: skill.version,
    description: skill.description,
    files,
  };
}
