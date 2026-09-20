import { sha256 } from "./hash";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { discoverCapabilities } from "@sourceweft/capability-runtime";
import type {
  CapabilityManifest,
  SkillContribution,
} from "@sourceweft/capability-contracts";
import type { SkillManifestJson } from "@sourceweft/db";
import { resolveBackendRuntimePath } from "../../shared/runtime-paths";
import { config } from "../../shared/config";
import { classifySkillFile } from "./file-kind";
import { SKILL_STORAGE_LIMITS } from "./storage/limits";
import { getSourceWeftFrontmatter, parseSkillFrontmatter } from "./frontmatter";

export type SkillBundleFile = {
  path: string;
  mimeType: string;
  sizeBytes: number;
  /** sha256 over the file's bytes. */
  contentHash: string;
} & (
  | { isText: true; contentText: string }
  | {
      /**
       * A font, an image, a template: what a skill's scripts work with and the
       * model never reads. The bytes stay on disk until the sandbox bundle is
       * built, rather than riding along with every turn that lists the skill.
       */
      isText: false;
      contentText: null;
      readBytes: () => Promise<Uint8Array>;
    }
);

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

let builtinSkillsCache: BuiltinSkillManifest[] | null = null;

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
    // Forwarded verbatim. The host never reads `key`/`path` — they name a
    // capability's own model-catalog annotation, and the composer resolves
    // them.
    ...(option.modelValues ? { modelValues: option.modelValues } : {}),
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

  const listing = input.skill.listing ?? "listed";
  const managed = input.skill.managed ?? false;

  const manifestJson: SkillManifestJson = {
    slug: input.parsedFrontmatter.slug,
    displayName,
    version: input.capability.version,
    description: description.trim(),
    visibility,
    listing,
    managed,
    categories,
    slash,
  };
  if (input.skill.defaultEnabled !== undefined) {
    manifestJson.defaultEnabled = input.skill.defaultEnabled;
  }
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

/**
 * What is known about a binary file without reading it again. Builtin packages
 * are re-read from disk on every load, which is nothing for text and would be
 * tens of megabytes per turn for a font set; a file whose size and mtime have
 * not moved is the same file.
 */
const binaryFileFacts = new Map<
  string,
  { sizeBytes: number; mtimeMs: number; mimeType: string; contentHash: string }
>();

async function collectSkillFile(
  skillDir: string,
  filePath: string,
): Promise<SkillBundleFile> {
  const relativePath = normalizeRelativePath(skillDir, filePath);
  const readBytes = () => readFile(filePath);
  const stats = await stat(filePath);
  const known = binaryFileFacts.get(filePath);
  if (
    known &&
    known.sizeBytes === stats.size &&
    known.mtimeMs === stats.mtimeMs
  ) {
    return {
      path: relativePath,
      mimeType: known.mimeType,
      sizeBytes: known.sizeBytes,
      contentHash: known.contentHash,
      isText: false,
      contentText: null,
      readBytes,
    };
  }
  const bytes = await readBytes();
  const kind = classifySkillFile(relativePath, bytes);
  const base = {
    path: relativePath,
    mimeType: kind.mimeType,
    sizeBytes: bytes.byteLength,
    contentHash: sha256(bytes),
  };
  if (kind.isText) {
    binaryFileFacts.delete(filePath);
    return { ...base, isText: true, contentText: kind.contentText };
  }
  binaryFileFacts.set(filePath, {
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
    mimeType: base.mimeType,
    contentHash: base.contentHash,
  });
  return { ...base, isText: false, contentText: null, readBytes };
}

/** Every file of one skill directory. Exported for its tests. */
export async function collectSkillFiles(skillDir: string) {
  const normalizedSkillDir = path.resolve(skillDir);
  return Promise.all(
    (await collectFiles(normalizedSkillDir)).map((filePath) =>
      collectSkillFile(normalizedSkillDir, filePath),
    ),
  );
}

/**
 * A builtin is staged into the sandbox under the same limits as every other
 * skill, so one that breaks them could be listed and never run.
 */
function builtinBundleLimitViolation(
  files: ReadonlyArray<Pick<SkillBundleFile, "path" | "sizeBytes">>,
): string | null {
  const MiB = 1024 * 1024;
  if (files.length > SKILL_STORAGE_LIMITS.maxFiles) {
    return `has ${files.length} files, more than the ${SKILL_STORAGE_LIMITS.maxFiles}-file limit for one skill`;
  }
  const oversize = files.find(
    (file) => file.sizeBytes > SKILL_STORAGE_LIMITS.maxFileBytes,
  );
  if (oversize) {
    return `ships '${oversize.path}' (${Math.ceil(oversize.sizeBytes / MiB)} MiB), more than the ${SKILL_STORAGE_LIMITS.maxFileBytes / MiB} MiB limit for one file`;
  }
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (total > SKILL_STORAGE_LIMITS.maxBundleBytes) {
    return `is ${Math.ceil(total / MiB)} MiB in total, more than the ${SKILL_STORAGE_LIMITS.maxBundleBytes / MiB} MiB limit for one skill`;
  }
  return null;
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
    const contributions = record.manifest.contributes;
    return (
      record.manifest.id.startsWith(`${builtinCapabilityNamespace()}/`) &&
      record.manifest.kind === "skill" &&
      contributions.skills.length > 0
    );
  });
  const skills = await Promise.all(
    skillRecords
      .flatMap((record) =>
        record.manifest.contributes.skills.map((skill) => ({
          record,
          skill,
        })),
      )
      .map(async ({ record, skill }) => {
        const skillDir = record.rootDir;
        const files = await collectSkillFiles(skillDir);
        const skillMd = files.find((file) => file.path === "SKILL.md");
        if (!skillMd?.isText) {
          throw new Error(`Builtin skill '${skill.id}' missing SKILL.md`);
        }
        const overLimit = builtinBundleLimitViolation(files);
        if (overLimit) {
          // Found at boot, not by the first user whose turn cannot stage it.
          throw new Error(`Builtin skill '${skill.id}' ${overLimit}`);
        }
        const parsed = parseBuiltinManifestFromFrontmatter(
          parseSkillFrontmatter(skillMd.contentText) ?? {},
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
