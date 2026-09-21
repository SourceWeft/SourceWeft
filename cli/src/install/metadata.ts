import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "@sourceweft/skill-format";

/**
 * What an installed skill records about where it came from. It lives inside the
 * skill's own directory, so it travels with the directory and vanishes with it
 * — there is no separate lockfile to fall out of step.
 */

export const METADATA_FILE = ".sourceweft.json";

export type InstalledMetadata = {
  schema: 1;
  /** The registry the skill was resolved from. */
  registry: string;
  slug: string;
  /** The registry's version id — a commit sha prefix for a GitHub skill. */
  version: string;
  source: {
    repoUrl: string | null;
    commitSha: string;
    /** The skill's directory in the repository; "" at the repository root. */
    subpath: string;
  };
  license: string | null;
  /** Bundle path → sha256 of what was written, excluding this file. */
  files: Record<string, string>;
  installedAt: string;
  installedVia: "cli";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns null for anything that is not a well-formed record of ours. */
export function parseMetadata(raw: string): InstalledMetadata | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.schema !== 1) {
    return null;
  }
  const { source, files } = value;
  if (
    typeof value.registry !== "string" ||
    typeof value.slug !== "string" ||
    typeof value.version !== "string" ||
    !isRecord(source) ||
    typeof source.commitSha !== "string" ||
    typeof source.subpath !== "string" ||
    !(source.repoUrl === null || typeof source.repoUrl === "string") ||
    !(value.license === null || typeof value.license === "string") ||
    !isRecord(files) ||
    !Object.values(files).every((hash) => typeof hash === "string") ||
    typeof value.installedAt !== "string" ||
    value.installedVia !== "cli"
  ) {
    return null;
  }
  return {
    schema: 1,
    registry: value.registry,
    slug: value.slug,
    version: value.version,
    source: {
      repoUrl: source.repoUrl,
      commitSha: source.commitSha,
      subpath: source.subpath,
    },
    license: value.license,
    files: files as Record<string, string>,
    installedAt: value.installedAt,
    installedVia: "cli",
  };
}

export function serializeMetadata(metadata: InstalledMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

/** The metadata of the skill installed at `dir`, or null if it is not ours. */
export async function readMetadata(
  dir: string,
): Promise<InstalledMetadata | null> {
  try {
    return parseMetadata(await readFile(join(dir, METADATA_FILE), "utf8"));
  } catch {
    return null;
  }
}

export type LocalChanges = {
  modified: string[];
  missing: string[];
  /** Files in the skill directory that the install did not put there. */
  added: string[];
};

/** Every file under `dir` (not following links), as `/`-separated relative paths. */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(dir, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await listFiles(dir, rel)));
    } else {
      found.push(rel);
    }
  }
  return found;
}

/**
 * How the directory differs from what was installed. Anything here is
 * something an update or a remove would destroy: edited and missing files
 * would be overwritten, and added files would go with the old directory.
 */
export async function detectLocalChanges(
  dir: string,
  metadata: InstalledMetadata,
): Promise<LocalChanges> {
  const changes: LocalChanges = { modified: [], missing: [], added: [] };
  for (const [path, hash] of Object.entries(metadata.files)) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(dir, ...path.split("/")));
    } catch {
      changes.missing.push(path);
      continue;
    }
    if (sha256(bytes) !== hash) {
      changes.modified.push(path);
    }
  }
  for (const path of await listFiles(dir)) {
    if (path !== METADATA_FILE && !(path in metadata.files)) {
      changes.added.push(path);
    }
  }
  changes.added.sort();
  return changes;
}

/**
 * Whether the directory holds anything the registry did not deliver. `added`
 * files can be left out for a check about the recorded files alone, such as
 * "is this the same content as before".
 */
export function hasLocalChanges(
  changes: LocalChanges,
  options: { includeAdded?: boolean } = {},
): boolean {
  return (
    changes.modified.length > 0 ||
    changes.missing.length > 0 ||
    (options.includeAdded !== false && changes.added.length > 0)
  );
}

export type MetadataState =
  | { state: "absent" }
  | { state: "corrupt" }
  | { state: "ok"; metadata: InstalledMetadata };

/** Like `readMetadata`, but tells "not ours" apart from "ours and damaged". */
export async function readMetadataState(dir: string): Promise<MetadataState> {
  let raw: string;
  try {
    raw = await readFile(join(dir, METADATA_FILE), "utf8");
  } catch {
    return { state: "absent" };
  }
  const metadata = parseMetadata(raw);
  return metadata ? { state: "ok", metadata } : { state: "corrupt" };
}
