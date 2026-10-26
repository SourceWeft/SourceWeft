import { z } from "zod";
import { parseGitHubRepoRef } from "../readme/github-readme";

/**
 * The license and main language a catalog entry shows, resolved from the
 * sources the catalog already holds (Issue #367). Pure: the read layer, the
 * score and the README fetch share these rules.
 *
 * Sources, in priority order — an owner's own words (applied by the read
 * layer on top of this) first, then:
 *
 * 1. the GitHub repository the entry names (`licenseInfo`, `primaryLanguage`
 *    from the README fetcher's GraphQL query), stored under
 *    {@link MCP_REPOSITORY_METADATA_KEY};
 * 2. the package manifest the entry was parsed from (`manifest.license`,
 *    `manifest.language`: `package.json` and `pyproject.toml` hints of a
 *    submitted repository);
 * 3. the GitHub MCP Registry row's license (`provenance.githubRegistry`), only
 *    when the row matched the entry by its registry name.
 *
 * A value describes an artifact, not the listing. A hosted service — a remote
 * endpoint with no package and no repository to read — has none: the license
 * of an obsolete self-hosted repository does not apply to it, so nothing is
 * resolved for it. A monorepo subfolder takes the repository's license but
 * not its language: the repository's dominant language says nothing about one
 * server inside it.
 */

export const MCP_REPOSITORY_METADATA_KEY = "repositoryMetadata";

/** What the README fetch's repository query kept about the entry's repository. */
export const mcpRepositoryMetadataSchema = z.object({
  /** `owner/repo`, lower case: the repository the values were read from. */
  repository: z.string().min(1).max(200),
  /** The server's directory in that repository; "" for the root. */
  subfolder: z.string().max(500).default(""),
  /** The SPDX id GitHub detected; absent when it detected none. */
  license: z.string().min(1).max(120).optional(),
  /** GitHub's primary language name; absent for an empty repository. */
  language: z.string().min(1).max(64).optional(),
  /** When GitHub was asked (ISO time). */
  observedAt: z.string(),
});
export type McpRepositoryMetadata = z.infer<typeof mcpRepositoryMetadataSchema>;

// ---------------------------------------------------------------------------
// Normalising the values
// ---------------------------------------------------------------------------

/** What sources write when they mean "no license": never shown, never counted. */
const NO_LICENSE = new Set([
  "unknown",
  "none",
  "other",
  "unlicensed",
  "noassertion",
  "nolicense",
  "no-license",
  "no license",
  "null",
  "undefined",
  "custom",
  "tbd",
]);

/** Common names of licenses, by a lower-case key without punctuation. */
const LICENSE_NAMES: Record<string, string> = {
  "mit": "MIT",
  "mit license": "MIT",
  "the mit license": "MIT",
  "apache 2.0": "Apache-2.0",
  "apache-2.0": "Apache-2.0",
  "apache license 2.0": "Apache-2.0",
  "apache license, version 2.0": "Apache-2.0",
  "apache software license": "Apache-2.0",
  "isc": "ISC",
  "isc license": "ISC",
  "bsd 2-clause": "BSD-2-Clause",
  "bsd-2-clause": "BSD-2-Clause",
  "bsd 3-clause": "BSD-3-Clause",
  "bsd-3-clause": "BSD-3-Clause",
  "bsd 3-clause license": "BSD-3-Clause",
  "gpl-2.0": "GPL-2.0",
  "gpl-3.0": "GPL-3.0",
  "gnu general public license v3.0": "GPL-3.0",
  "gnu general public license v2.0": "GPL-2.0",
  "lgpl-3.0": "LGPL-3.0",
  "agpl-3.0": "AGPL-3.0",
  "gnu affero general public license v3.0": "AGPL-3.0",
  "mpl-2.0": "MPL-2.0",
  "mozilla public license 2.0": "MPL-2.0",
  "the unlicense": "Unlicense",
  "unlicense": "Unlicense",
  "cc0-1.0": "CC0-1.0",
  "0bsd": "0BSD",
};

/** One SPDX id or an expression of ids joined by AND / OR / WITH. */
const SPDX_EXPRESSION =
  /^[A-Za-z0-9][A-Za-z0-9.+-]*(?: (?:AND|OR|WITH) [A-Za-z0-9][A-Za-z0-9.+-]*)*$/;

/**
 * A license as it is shown and counted: a trimmed SPDX id or expression, with
 * common long names mapped to their id ("MIT License" → "MIT"). Placeholders
 * ("Unknown", "UNLICENSED", "Other", "SEE LICENSE IN LICENSE") and free text
 * that is not an id are null — nothing is shown rather than a guess. Applied
 * to every source, the owner's included, so they display alike.
 */
export function normaliseLicense(value: unknown): string | null {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text || text.length > 120) return null;
  const lower = text.toLowerCase();
  if (NO_LICENSE.has(lower)) return null;
  const named = LICENSE_NAMES[lower];
  if (named) return named;
  return SPDX_EXPRESSION.test(text) ? text : null;
}

/** A language name as shown; placeholders are null. */
export function normaliseLanguage(value: unknown): string | null {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text || text.length > 64) return null;
  return NO_LICENSE.has(text.toLowerCase()) || /^n\/?a$/i.test(text)
    ? null
    : text;
}

export type ListingMetadataSource = "github" | "package" | "github-registry";

export type ResolvedListingMetadata = {
  license: string | null;
  language: string | null;
  licenseSource: ListingMetadataSource | null;
  languageSource: ListingMetadataSource | null;
  /** A remote endpoint with nothing to install or read. */
  hostedOnly: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isHttpUrl(value: unknown): boolean {
  const candidate = text(value);
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * True when the registry entry lists remotes and nothing to install or read:
 * no package, no repository. Read from what the entry says about how it is
 * delivered; an entry that says nothing (a submission, a row from before
 * `registryServer` was kept) is not hosted-only, so the license applies.
 */
export function isHostedOnly(input: {
  manifest: Record<string, unknown>;
  provenance: Record<string, unknown>;
  registryServer: Record<string, unknown> | null;
}): boolean {
  const { manifest, provenance, registryServer } = input;
  if (!registryServer) return false;
  const remotes = Array.isArray(registryServer.remotes)
    ? registryServer.remotes
    : [];
  const packages = Array.isArray(registryServer.packages)
    ? registryServer.packages
    : [];
  if (remotes.length === 0 || packages.length > 0) return false;
  return !(
    text(record(provenance.repository)?.url) !== null ||
    isHttpUrl(manifest.repoUrl)
  );
}

/**
 * The record GitHub's answer makes: the SPDX id of the repository's license
 * (GitHub's `NOASSERTION` — a license file it could not identify — is no
 * license to show) and its primary language. Null when GitHub gave neither.
 */
export function repositoryMetadataFromGithub(input: {
  owner: string;
  repo: string;
  subfolder: string;
  licenseInfo: { spdxId?: string | null } | null | undefined;
  primaryLanguage: { name?: string | null } | null | undefined;
  observedAt: Date;
}): McpRepositoryMetadata {
  const spdx = normaliseLicense(input.licenseInfo?.spdxId);
  const language = text(input.primaryLanguage?.name);
  return {
    repository: `${input.owner}/${input.repo}`.toLowerCase(),
    subfolder: input.subfolder,
    ...(spdx ? { license: spdx } : {}),
    ...(language ? { language } : {}),
    observedAt: input.observedAt.toISOString(),
  };
}

/** The entry's GitHub repository as `owner/repo` (lower case), or null. */
function repositoryOf(input: {
  repoUrl: string | null | undefined;
  provenance: Record<string, unknown>;
}): string | null {
  // An empty URL is no URL: `??` would not fall back from "".
  const parsed = parseGitHubRepoRef(
    text(input.repoUrl) ?? text(record(input.provenance.repository)?.url),
  );
  return "unsupported" in parsed
    ? null
    : `${parsed.owner}/${parsed.repo}`.toLowerCase();
}

export function resolveListingMetadata(input: {
  manifestJson: unknown;
  provenanceJson: unknown;
  /** The server row's repository URL. */
  repoUrl?: string | null;
}): ResolvedListingMetadata {
  const manifest = record(input.manifestJson) ?? {};
  const provenance = record(input.provenanceJson) ?? {};
  const registryServer = record(provenance.registryServer);
  const hostedOnly =
    isHttpUrl(manifest.endpointUrl) &&
    isHostedOnly({ manifest, provenance, registryServer });
  const none: ResolvedListingMetadata = {
    license: null,
    language: null,
    licenseSource: null,
    languageSource: null,
    hostedOnly,
  };
  if (hostedOnly) return none;

  const repository = repositoryOf({ repoUrl: input.repoUrl, provenance });
  const parsedRepository = mcpRepositoryMetadataSchema.safeParse(
    provenance[MCP_REPOSITORY_METADATA_KEY],
  );
  // Values read from another repository than the entry names now (the entry
  // moved, or was re-pointed) describe something else.
  const github =
    parsedRepository.success &&
    repository !== null &&
    parsedRepository.data.repository === repository
      ? parsedRepository.data
      : null;
  const registry = record(provenance.githubRegistry);

  const license: [string | null, ListingMetadataSource][] = [
    [normaliseLicense(github?.license), "github"],
    [normaliseLicense(manifest.license), "package"],
    [
      registry?.matchedBy === "name" ? normaliseLicense(registry.license) : null,
      "github-registry",
    ],
  ];
  const language: [string | null, ListingMetadataSource][] = [
    [
      github && github.subfolder === "" ? normaliseLanguage(github.language) : null,
      "github",
    ],
    [normaliseLanguage(manifest.language), "package"],
  ];
  const firstOf = (candidates: [string | null, ListingMetadataSource][]) =>
    candidates.find(([value]) => value !== null);
  const pickedLicense = firstOf(license);
  const pickedLanguage = firstOf(language);
  return {
    license: pickedLicense?.[0] ?? null,
    language: pickedLanguage?.[0] ?? null,
    licenseSource: pickedLicense?.[1] ?? null,
    languageSource: pickedLanguage?.[1] ?? null,
    hostedOnly,
  };
}
