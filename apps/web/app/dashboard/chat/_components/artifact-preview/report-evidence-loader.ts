import { contentClient } from "../../../../../lib/sdk";
import {
  parseReportEvidenceSources,
  REPORT_SOURCE_FILE_NAME,
  type ReportEvidenceSource,
} from "./report-evidence";

/**
 * Loads the private `report.source.json` of one exact artifact version for
 * the evidence panel and shares the result across every panel that asks for
 * it. The artifact preview is mounted more than once at a time (the Hub's
 * inline panel and the expanded dialog, each doubled by React StrictMode in
 * development), so the cache lives at module level rather than per instance:
 * concurrent callers share one in-flight request, and settled answers are
 * remembered for the session.
 *
 * Only settled outcomes are cached: a parsed source list, or `null` for a
 * version that has no readable report source (404) or whose file is not a
 * report source. Transient failures (network, 401 during token refresh, 5xx)
 * are not cached so a later open retries.
 */

type EvidenceResult = ReportEvidenceSource[] | null;

const MAX_SETTLED_ENTRIES = 64;

const settled = new Map<string, EvidenceResult>();
const inflight = new Map<string, Promise<EvidenceResult>>();

function evidenceKey(
  workspaceId: string,
  artifactId: string,
  versionId: string,
) {
  return `${workspaceId}:${artifactId}:${versionId}`;
}

function isNotFoundError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 404
  );
}

function remember(key: string, result: EvidenceResult) {
  // Re-inserting moves the key to the end, so eviction drops the least
  // recently settled version first.
  settled.delete(key);
  settled.set(key, result);
  while (settled.size > MAX_SETTLED_ENTRIES) {
    const oldest = settled.keys().next().value;
    if (oldest === undefined) break;
    settled.delete(oldest);
  }
}

export function loadReportEvidence(
  workspaceId: string,
  artifactId: string,
  versionId: string,
): Promise<EvidenceResult> {
  const key = evidenceKey(workspaceId, artifactId, versionId);
  const known = settled.get(key);
  if (known !== undefined) {
    return Promise.resolve(known);
  }
  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }
  const request = contentClient
    .readArtifactVersionSourceFile(
      workspaceId,
      artifactId,
      versionId,
      REPORT_SOURCE_FILE_NAME,
    )
    .then((document) => {
      const sources = parseReportEvidenceSources(document);
      remember(key, sources);
      return sources;
    })
    .catch((error: unknown) => {
      if (isNotFoundError(error)) {
        remember(key, null);
      }
      return null;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

/** Test hook: forget every settled and in-flight evidence load. */
export function resetReportEvidenceCache() {
  settled.clear();
  inflight.clear();
}
