import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillManifestJson } from "../../../shared/db/schema";

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

function parseBuiltinManifest(value: unknown, source: string): ParsedBuiltinManifest {
  assertRecord(value, source);
  const slug = value.slug;
  const displayName = value.displayName;
  const description = value.description;
  const visibility = value.visibility;
  const categories = value.categories;
  const version = value.version;

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

  return {
    slug,
    displayName: displayName.trim(),
    description: description.trim(),
    visibility,
    categories: Array.from(new Set(normalizedCategories)),
    version: version.trim(),
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
