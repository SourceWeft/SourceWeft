import {
  marketMcpManifestSchema,
  type MarketMcpManifest,
  type McpReadmeStatus,
} from "@sourceweft/market-contracts";
import type { RegistryServerJson } from "../types";
import {
  buildMcpOverviewInput,
  type McpOverviewInput,
  type McpOverviewSource,
} from "./input";

/**
 * From stored rows to what the overview is written from, and the decisions
 * about which versions need one. Pure: the SQL is in ./repository.ts.
 */

const SHA256_RE = /^[0-9a-f]{64}$/;

/** A version's stored fields the overview input is built from. */
export type McpOverviewSourceRow = {
  manifestJson: unknown;
  provenanceJson: unknown;
  readmeStatus: McpReadmeStatus;
  readmeSha256: string | null;
};

/** The stored manifest, or null when it no longer parses. */
export function storedManifest(value: unknown): MarketMcpManifest | null {
  const parsed = marketMcpManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The packages and remotes federation (or a submission) kept for the version
 * (`provenance.registryServer`, see `registry-server.ts`); null without them.
 */
export function storedRegistryServer(
  provenanceJson: unknown,
): RegistryServerJson | null {
  if (!isRecord(provenanceJson)) return null;
  const server = provenanceJson.registryServer;
  return isRecord(server) ? (server as RegistryServerJson) : null;
}

/** Whether the stored README is one the overview reads: fetched, with its hash. */
export function readableReadme(row: {
  readmeStatus: McpReadmeStatus;
  readmeSha256: string | null;
  hasReadmeText: boolean;
}): boolean {
  return (
    row.readmeStatus === "ok" &&
    row.hasReadmeText &&
    SHA256_RE.test(row.readmeSha256 ?? "")
  );
}

/**
 * The overview source of a version: its manifest, the author's description
 * (the registry's, for a federated entry), the README when it was fetched
 * (`readme_status = 'ok'`), and the kept packages and remotes. Null when the
 * stored manifest no longer parses.
 */
export function mcpOverviewSource(
  row: McpOverviewSourceRow & { readmeMd: string | null },
): McpOverviewSource | null {
  const manifest = storedManifest(row.manifestJson);
  if (!manifest) return null;
  const readme =
    row.readmeMd !== null && readableReadme({ ...row, hasReadmeText: true })
      ? { markdown: row.readmeMd, sha256: row.readmeSha256! }
      : null;
  return {
    manifest,
    // The manifest's own description: for a federated entry, the registry's
    // text as it gave it. Never the summary, which federation fills with a
    // made-up sentence when the registry has no description.
    registryDescription: manifest.description ?? null,
    readme,
    registryServer: storedRegistryServer(row.provenanceJson),
  };
}

/** The overview input of a version, or null when its manifest does not parse. */
export function mcpOverviewInputOf(
  row: McpOverviewSourceRow & { readmeMd: string | null },
): McpOverviewInput | null {
  const source = mcpOverviewSource(row);
  return source ? buildMcpOverviewInput(source) : null;
}

/**
 * The input fingerprint of a version without reading its README: the
 * fingerprint covers the README's hash, never its text, so the scheduler can
 * tell a stale overview from a current one without loading every README. The
 * same `buildMcpOverviewInput` computes it, from an empty README with the
 * stored hash. Null when the manifest does not parse.
 */
export function mcpOverviewFingerprint(
  row: McpOverviewSourceRow & { hasReadmeText: boolean },
): string | null {
  const manifest = storedManifest(row.manifestJson);
  if (!manifest) return null;
  return buildMcpOverviewInput({
    manifest,
    registryDescription: manifest.description ?? null,
    readme: readableReadme(row)
      ? { markdown: "", sha256: row.readmeSha256! }
      : null,
    registryServer: storedRegistryServer(row.provenanceJson),
  }).inputSha256;
}

// ---------------------------------------------------------------------------
// Which versions need an overview
// ---------------------------------------------------------------------------

/**
 * Failures the scheduler tries again as soon as it sees them: the reason is
 * gone by the time the version is a candidate again (it is eligible, its
 * README is no longer pending, and the tick only runs while the system model
 * is ready).
 */
export const MCP_OVERVIEW_RETRYABLE_FAILURES: ReadonlySet<string> = new Set([
  "not-eligible",
  "readme-pending",
  "system-model-not-ready",
]);

/** An attempted version as the scheduler's rotating check reads it. */
export type McpOverviewAttempt = McpOverviewSourceRow & {
  hasReadmeText: boolean;
  status: "ready" | "needs-review" | "failed";
  error: string | null;
  // The README was read (fetched, or found unchanged) after the analysis row
  // last changed.
  readmeReadSince: boolean;
  // The input fingerprint of the published overview; null without one.
  overviewSha256: string | null;
};

/**
 * Whether an attempted version is queued again:
 * - a published overview whose input fingerprint is no longer the version's
 *   (README, manifest, packages, description, prompt or taxonomy changed);
 * - a failure whose reason has passed (`MCP_OVERVIEW_RETRYABLE_FAILURES`), or
 *   any failure once the README has been read again since — so a failure that
 *   keeps failing (the model, or nothing to describe) is tried at most once
 *   per README refresh, not on every tick.
 */
export function needsMcpOverviewRetry(attempt: McpOverviewAttempt): boolean {
  if (attempt.status === "failed") {
    return (
      MCP_OVERVIEW_RETRYABLE_FAILURES.has(attempt.error ?? "") ||
      attempt.readmeReadSince
    );
  }
  const fingerprint = mcpOverviewFingerprint(attempt);
  return fingerprint !== null && attempt.overviewSha256 !== fingerprint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
