import {
  marketMcpGithubRegistryProvenanceSchema,
  type MarketMcpGithubRegistryMatch,
  type MarketMcpGithubRegistryProvenance,
  type MarketMcpManifest,
} from "@sourceweft/market-contracts";
import type { GithubRegistryRow } from "./fetch";

/**
 * What a match writes. The provenance record is the whole of what is kept
 * from GitHub; the manifest changes are two narrow rules on top of it. Icons,
 * tools, auth and categories are never touched here: the logo chain reads
 * `ownerAvatarUrl` from the record itself.
 */

/** The record kept on the matched version's provenance. */
export function githubRegistryRecord(
  row: GithubRegistryRow,
  matchedBy: MarketMcpGithubRegistryMatch,
  fetchedAt: Date,
): MarketMcpGithubRegistryProvenance {
  const candidate = {
    name: row.name,
    matchedBy,
    ownerAvatarUrl: row.github.ownerAvatarUrl,
    stars: row.github.stars,
    license: row.github.license,
    displayName: row.github.displayName,
    description: row.description,
    fetchedAt: fetchedAt.toISOString(),
  };
  // The parser already bounded every field; the schema is the contract the
  // readers hold us to. An optional field the schema refuses is dropped (the
  // others stay), and an absent one is left out rather than stored as null.
  const parsed = marketMcpGithubRegistryProvenanceSchema.safeParse(candidate);
  const record = parsed.success
    ? parsed.data
    : marketMcpGithubRegistryProvenanceSchema.parse(
        Object.fromEntries(
          Object.entries(candidate).filter(
            ([key]) =>
              !parsed.error.issues.some((issue) => issue.path[0] === key),
          ),
        ),
      );
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as MarketMcpGithubRegistryProvenance;
}

/** The manifest fields the two rules read and may change. */
export type GithubRegistryManifestFields = Pick<
  MarketMcpManifest,
  "identifier" | "name" | "summary"
> & { description?: string | null };

export type GithubRegistryManifestPatch = Partial<
  Pick<MarketMcpManifest, "name" | "summary" | "description">
>;

/** The manifest's `summary` as federation derives it from a description. */
const SUMMARY_CHARS = 500;

export type GithubRegistryManifestOptions = {
  /**
   * The generic-name fallback for the manifest's identifier
   * (`genericFallbackName` in `federation.ts`: "Notion" for `com.notion/mcp`),
   * or undefined when the server name is specific. Passed in rather than
   * imported so this module does not import federation, which imports it.
   */
  fallbackName: string | undefined;
  /**
   * Whether the registry entry has no `title`: known from the entry itself
   * in a federation sync, and from the stored `registryServer.title` in the
   * daily pass. False when unknown (a version synced before the title was
   * kept), so a publisher's title is never replaced on a guess.
   */
  untitled: boolean;
};

/**
 * The manifest changes a record earns, as a patch; empty when it earns none:
 * - `name` ← the row's `displayName` only when the registry entry has no
 *   title AND our name is the generic-name fallback for its identifier
 *   ("Notion" for `com.notion/mcp`); a title that happens to equal the
 *   fallback is the publisher's choice and stays;
 * - `description` ← the row's description only when it is longer than ours;
 *   `summary` follows it when it was the description's own first 500
 *   characters, or when there was no description to derive it from (it was
 *   then the "MCP server … from the MCP registry" placeholder).
 * Applied to a manifest it already changed, the patch is empty.
 */
export function githubRegistryManifestPatch(
  manifest: GithubRegistryManifestFields,
  record: MarketMcpGithubRegistryProvenance,
  options: GithubRegistryManifestOptions,
): GithubRegistryManifestPatch {
  const patch: GithubRegistryManifestPatch = {};
  const fallback = options.fallbackName;
  if (
    options.untitled &&
    record.displayName &&
    fallback !== undefined &&
    manifest.name === fallback &&
    record.displayName !== manifest.name
  ) {
    patch.name = record.displayName;
  }
  const ours = manifest.description ?? "";
  if (record.description && record.description.length > ours.length) {
    patch.description = record.description;
    const derived = ours.slice(0, SUMMARY_CHARS);
    if (!ours || manifest.summary === derived) {
      const summary = record.description.slice(0, SUMMARY_CHARS);
      if (summary !== manifest.summary) patch.summary = summary;
    }
  }
  return patch;
}

/**
 * `manifest` with a stored record's rules applied, for a federation sync that
 * rebuilds the manifest from the upstream entry: the record outlives the
 * sync, so must its two changes. `value` is the stored provenance field, in
 * whatever shape it was found; anything but a valid record changes nothing.
 */
export function applyGithubRegistryToManifest(
  manifest: MarketMcpManifest,
  value: unknown,
  options: GithubRegistryManifestOptions,
): {
  manifest: MarketMcpManifest;
  record: MarketMcpGithubRegistryProvenance | undefined;
} {
  const parsed = marketMcpGithubRegistryProvenanceSchema.safeParse(value);
  if (!parsed.success) return { manifest, record: undefined };
  const patch = githubRegistryManifestPatch(manifest, parsed.data, options);
  return {
    manifest:
      Object.keys(patch).length > 0 ? { ...manifest, ...patch } : manifest,
    record: parsed.data,
  };
}
