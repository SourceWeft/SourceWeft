import { createHash } from "node:crypto";
import path from "node:path";
import type { SkillManifestJson } from "../../../shared/db/schema";

export const CUSTOM_SKILL_LIMITS = {
  skillMdBytes: 256 * 1024,
  fileBytes: 256 * 1024,
  bundleBytes: 1024 * 1024,
  fileCount: 50,
};

const ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);
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

function validateSkillName(name: string) {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) &&
    !name.includes("--");
}

function validateDisplayName(name: string) {
  return name.trim().length > 0 && name.length <= 128;
}

function normalizeCategory(value: unknown) {
  return typeof value === "string" && validateSkillName(value) ? value : null;
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
    throw new Error(error instanceof Error ? error.message : "skill.json is invalid JSON");
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
    throw new Error(`Custom skill bundle exceeds ${CUSTOM_SKILL_LIMITS.fileCount} files`);
  }

  const seen = new Set<string>();
  const files = input.files.map((file) => {
    const validated = validateCustomSkillFileInput(file);
    if (seen.has(validated.path)) {
      throw new Error(`Duplicate custom skill file path '${validated.path}'`);
    }
    seen.add(validated.path);
    return validated;
  }).sort((a, b) => a.path.localeCompare(b.path));

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

  const frontmatter = parseFrontmatter(skillMd.contentText);
  const skillJson = firstJsonObject(files);
  const slug = String(skillJson?.slug ?? frontmatter.name ?? "").trim();
  const displayName = String(skillJson?.displayName ?? slug).trim();
  const version = String(skillJson?.version ?? "0.1.0").trim();
  const description = String(skillJson?.description ?? frontmatter.description ?? "").trim();
  const visibility = String(skillJson?.visibility ?? "workspace").trim();
  const categoriesValue = skillJson?.categories;
  const categories = Array.isArray(categoriesValue)
    ? categoriesValue.map(normalizeCategory).filter((category): category is string => Boolean(category))
    : [];

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
  if (Array.isArray(categoriesValue) && categories.length !== categoriesValue.length) {
    throw new Error("Custom skill manifest categories are invalid");
  }
  if (!description || description.length > 1024) {
    throw new Error("Custom skill manifest description is invalid");
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
