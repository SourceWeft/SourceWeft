import { RegistrySubmissionError } from "./errors";

/**
 * Stage 4 — Guard (ownership + triage). Pure decision, no IO.
 * docs/architecture/skill-registry-index.md §3 Stage 4 / build phase R2.
 *
 * Mirrors `market/submission.ts`:
 *   - Ownership: a submission cannot overwrite another submitter's entry.
 *   - Sticky: once a definition/version is in review (draft) or tombstoned
 *     (deprecated / archived), a re-submit that merely drops the risky lines
 *     can't auto-index — only an admin moves it.
 *   - Triage: a clean submission indexes (version published); anything flagged
 *     or sticky queues for review (version draft).
 */

export type RegistryExistingEntry = {
  ownerUserId: string | null;
  definitionStatus: "active" | "archived";
  currentVersionStatus:
    | "draft"
    | "published"
    | "deprecated"
    | "disabled"
    | null;
} | null;

export type TriageInput = {
  existing: RegistryExistingEntry;
  submitterId: string;
  scan: { reviewRequired: boolean; flags: string[] };
};

export type TriageDecision = {
  /** Maps to the submit-response status (`indexed` | `queued`). */
  outcome: "indexed" | "queued";
  versionStatus: "published" | "draft";
  definitionStatus: "active";
  reasons: string[];
};

function isSticky(existing: NonNullable<RegistryExistingEntry>): boolean {
  return (
    existing.definitionStatus === "archived" ||
    existing.currentVersionStatus === "draft" ||
    existing.currentVersionStatus === "deprecated"
  );
}

export function triageRegistrySubmission(input: TriageInput): TriageDecision {
  const { existing, submitterId, scan } = input;

  // Ownership guard: any existing entry owned by a different submitter — in any
  // state — is off-limits, so an attacker can't overwrite a victim's listing or
  // poison their in-review submission (mirrors market's conflict guard).
  if (existing?.ownerUserId && existing.ownerUserId !== submitterId) {
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_CONFLICT",
      "This skill was already submitted by another user and cannot be overwritten.",
    );
  }

  const reasons: string[] = [];
  const sticky = existing ? isSticky(existing) : false;
  if (sticky) {
    reasons.push("sticky-review");
  }
  if (scan.reviewRequired) {
    reasons.push(...scan.flags);
  }

  const reviewRequired = scan.reviewRequired || sticky;

  return {
    outcome: reviewRequired ? "queued" : "indexed",
    versionStatus: reviewRequired ? "draft" : "published",
    definitionStatus: "active",
    reasons,
  };
}
