import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  discoverCapabilities,
  getCapabilityContributions,
} from "@sourceweft/capability-runtime";
import type {
  CapabilityManifest,
  SkillContribution,
} from "@sourceweft/capability-contracts";
import type { SkillManifestJson } from "@sourceweft/db";
import { resolveBackendRuntimePath } from "../../shared/runtime-paths";
import { config } from "../../shared/config";
import { getSourceWeftFrontmatter, parseSkillFrontmatter } from "./frontmatter";

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
  description: string;
};

type CapabilitySkillContribution = SkillContribution;

const packageWorkspaceRoot = resolveBackendRuntimePath({
  candidates: ["../../packages", "../packages"],
  envVar: "SOURCEWEFT_CAPABILITY_PACKAGES_DIR",
  label: "capability packages directory",
});

function capabilityStoragePointerPrefix() {
  return config.capability?.storagePointerPrefix ?? "capability-package:";
}

/** Capability ID namespace for first-party builtin capabilities. */
function builtinCapabilityNamespace() {
  return config.capability?.builtinNamespace ?? "sourceweft";
}

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

function validateSkillName(name: string) {
  return (
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) && !name.includes("--")
  );
}

function normalizeCategory(value: unknown) {
  return typeof value === "string" && validateSkillName(value) ? value : null;
}

function normalizeDisplayName(value: unknown) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 128
    ? value.trim()
    : null;
}

function parseBuiltinManifestFromFrontmatter(
  frontmatter: Record<string, unknown>,
  source: string,
): ParsedBuiltinManifest {
  const sourceweft = getSourceWeftFrontmatter(frontmatter);
  if (Object.keys(sourceweft).length > 0) {
    throw new Error(
      `${source} must not contain SourceWeft metadata; use sourceweft.capability.json`,
    );
  }
  const slug = frontmatter.name;
  const description = frontmatter.description;

  if (typeof slug !== "string" || !validateSkillName(slug)) {
    throw new Error(`${source} slug is invalid`);
  }
  if (
    typeof description !== "string" ||
    description.trim().length === 0 ||
    description.length > 1024
  ) {
    throw new Error(`${source} description is invalid`);
  }

  return {
    slug,
    description: description.trim(),
  };
}

function normalizeCapabilitySkillCategories(input: {
  categories: readonly string[];
  source: string;
}) {
  const normalizedCategories = input.categories
    .map(normalizeCategory)
    .filter((category): category is string => Boolean(category));
  if (normalizedCategories.length !== input.categories.length) {
    throw new Error(`${input.source} categories are invalid`);
  }
  return Array.from(new Set(normalizedCategories));
}

function defaultSkillSlash(skill: CapabilitySkillContribution) {
  if (skill.slash !== undefined) {
    return skill.slash;
  }
  if (skill.runtime) {
    return false;
  }
  return Boolean(skill.command);
}

function workflowDefaultTools(skill: CapabilitySkillContribution) {
  const tools =
    skill.runtime?.tools ?? skill.command?.workflow?.defaultTools ?? [];
  return tools.length > 0 ? Array.from(new Set(tools)) : undefined;
}

function capabilityOptionsToSkillOptions(
  options: CapabilitySkillContribution["options"],
): SkillManifestJson["options"] {
  if (options.length === 0) {
    return undefined;
  }
  return options.map((option) => ({
    id: option.id,
    title: option.title,
    ...(option.description ? { description: option.description } : {}),
    valueType: option.valueType,
    ...(option.defaultValue !== undefined
      ? { defaultValue: option.defaultValue }
      : {}),
    target: {
      ...(option.target.toolName ? { toolName: option.target.toolName } : {}),
      path: option.target.path,
    },
    values: option.values.map((value) => ({
      value: value.value,
      ...(value.label ? { label: value.label } : {}),
    })),
  }));
}

function buildBuiltinManifestFromCapability(input: {
  readonly capability: CapabilityManifest;
  readonly parsedFrontmatter: ParsedBuiltinManifest;
  readonly skill: CapabilitySkillContribution;
  readonly source: string;
}): SkillManifestJson {
  const displayName =
    normalizeDisplayName(input.skill.title) ??
    normalizeDisplayName(input.capability.name) ??
    input.parsedFrontmatter.slug;
  const description =
    input.skill.description ??
    input.capability.description ??
    input.parsedFrontmatter.description;
  if (description.trim().length === 0 || description.length > 1024) {
    throw new Error(`${input.source} description is invalid`);
  }
  const visibility = input.skill.visibility ?? "public";
  const categories = normalizeCapabilitySkillCategories({
    categories: input.skill.categories,
    source: input.source,
  });
  const tools = workflowDefaultTools(input.skill);
  const options = capabilityOptionsToSkillOptions(input.skill.options);
  const defaultConfig =
    Object.keys(input.skill.defaultConfig).length > 0
      ? input.skill.defaultConfig
      : undefined;
  const slash = defaultSkillSlash(input.skill);

  const manifestJson: SkillManifestJson = {
    slug: input.parsedFrontmatter.slug,
    displayName,
    version: input.capability.version,
    description: description.trim(),
    visibility,
    categories,
    slash,
  };
  if (input.skill.models) {
    manifestJson.models = input.skill.models;
  }
  if (tools) {
    manifestJson.tools = tools;
  }
  if (options) {
    manifestJson.options = options;
  }
  if (input.skill.slashConfig) {
    manifestJson.slashConfig = input.skill.slashConfig;
  }
  if (defaultConfig) {
    manifestJson.defaultConfig = defaultConfig;
  }
  return manifestJson;
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
  const prefix = capabilityStoragePointerPrefix();
  if (normalized.startsWith(prefix)) {
    const capabilityId = normalized.slice(prefix.length);
    return capabilityId.split("/")[1] ?? null;
  }
  if (!normalized.includes("/")) {
    return normalized;
  }

  const [slug, legacySegment] = normalized.split("/");
  return slug && legacySegment === "versions" ? slug : null;
}

function normalizeRelativePath(baseDir: string, filePath: string) {
  return path.relative(baseDir, filePath).split(path.sep).join("/");
}

/**
 * Build output and dependency directories are not skill content. Without this
 * denylist the walk below picks up `.turbo/*.log` and `node_modules/.bin/*`
 * (shell scripts), reads them as UTF-8, mounts them under `/skills/<name>/`,
 * and folds them into the bundle hash — so a turbo log write invalidates the
 * bundle. Skills are re-read from disk every turn, so this is per-turn cost.
 */
const SKIP_SKILL_DIR_NAMES = new Set(["node_modules", "dist"]);

function isSkippedSkillDir(name: string) {
  return SKIP_SKILL_DIR_NAMES.has(name) || name.startsWith(".");
}

async function collectFiles(
  baseDir: string,
  currentDir = baseDir,
): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (isSkippedSkillDir(entry.name)) {
        continue;
      }
      files.push(...(await collectFiles(baseDir, fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function collectSkillFiles(skillDir: string) {
  const normalizedSkillDir = path.resolve(skillDir);
  return Promise.all(
    (await collectFiles(normalizedSkillDir)).map(async (filePath) => {
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

function hashFiles(
  files: Array<Pick<SkillBundleFile, "path" | "contentHash">>,
) {
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

  const discovery = await discoverCapabilities({
    roots: [packageWorkspaceRoot],
  });
  const skillRecords = discovery.records.filter((record) => {
    const contributions = getCapabilityContributions(record.manifest);
    return (
      record.manifest.id.startsWith(`${builtinCapabilityNamespace()}/`) &&
      record.manifest.kind === "skill" &&
      contributions.skills.length > 0
    );
  });
  const skills = await Promise.all(
    skillRecords
      .flatMap((record) =>
        getCapabilityContributions(record.manifest).skills.map((skill) => ({
          record,
          skill,
        })),
      )
      .map(async ({ record, skill }) => {
        const skillDir = record.rootDir;
        const files = await collectSkillFiles(skillDir);
        const skillMd = files.find((file) => file.path === "SKILL.md");
        if (!skillMd) {
          throw new Error(`Builtin skill '${skill.id}' missing SKILL.md`);
        }
        const parsed = parseBuiltinManifestFromFrontmatter(
          parseSkillFrontmatter(skillMd.contentText),
          `${skillDir}/SKILL.md`,
        );
        if (parsed.slug !== skill.id) {
          throw new Error(
            `Builtin skill '${skill.id}' frontmatter.name must be '${skill.id}'`,
          );
        }
        const manifestJson = buildBuiltinManifestFromCapability({
          capability: record.manifest,
          parsedFrontmatter: parsed,
          skill,
          source: `${skillDir}/sourceweft.capability.json`,
        });
        return {
          slug: manifestJson.slug,
          displayName: manifestJson.displayName,
          description: manifestJson.description,
          visibility: manifestJson.visibility as "public" | "restricted",
          categories: manifestJson.categories,
          version: manifestJson.version,
          manifestJson,
          storagePointer: `${capabilityStoragePointerPrefix()}${record.manifest.id}`,
          contentHash: hashFiles(files),
        };
      }),
  );

  const sortedSkills = skills.sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
  builtinSkillsCache = sortedSkills;
  return sortedSkills;
}

export async function listBuiltinSkills() {
  return [...(await loadBuiltinSkillsFromDisk())];
}

export async function getBuiltinSkillBySlug(slug: string) {
  return (
    (await loadBuiltinSkillsFromDisk()).find((skill) => skill.slug === slug) ??
    null
  );
}

export async function readBuiltinSkillFile(
  storagePointer: string,
  filePath: string,
) {
  const file = (await loadBuiltinSkillBundle(storagePointer))?.files.find(
    (item) => item.path === filePath,
  );
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

export async function loadBuiltinSkillBundle(
  storagePointer: string,
): Promise<BuiltinSkillBundle | null> {
  const slug = slugFromStoragePointer(storagePointer);
  if (!slug) {
    return null;
  }
  const skill = await getBuiltinSkillBySlug(slug);
  if (!skill) {
    return null;
  }
  const prefix = capabilityStoragePointerPrefix();
  const capabilityId = skill.storagePointer.startsWith(prefix)
    ? skill.storagePointer.slice(prefix.length)
    : `${builtinCapabilityNamespace()}/${skill.slug}`;
  const discovery = await discoverCapabilities({
    roots: [packageWorkspaceRoot],
  });
  const record = discovery.records.find(
    (candidate) => candidate.manifest.id === capabilityId,
  );
  if (!record) {
    return null;
  }
  const skillDir = record.rootDir;
  const files = await collectSkillFiles(skillDir);
  return {
    slug: skill.slug,
    version: skill.version,
    description: skill.description,
    files,
  };
}
