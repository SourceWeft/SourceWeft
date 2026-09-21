/**
 * Stage 4 — Guard (triage). Pure decision, no IO.
 * docs/architecture/skill-registry-index.md §3 Stage 4 / build phase R2.
 *
 *   - No ownership veto: anyone may submit a newer commit of the same public
 *     repository (see below). Control of the listing is not decided here.
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
    "draft" | "published" | "deprecated" | "disabled" | null;
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
    existing.currentVersionStatus === "deprecated" ||
    existing.currentVersionStatus === "disabled"
  );
}

export function triageRegistrySubmission(input: TriageInput): TriageDecision {
  const { existing, scan } = input;

  // No ownership veto. A registry entry is a public repository's skill, and
  // its content is whatever that repository holds at a commit on its default
  // branch (checked when the source is resolved): anyone submitting the same
  // repository can only bring a commit its own writers made. So a second
  // submitter adds a version and gets to use the skill, but not control of it —
  // the listing stays with its owner, and nothing here reads the submitter.
  // (It used to be refused outright, which let whoever imported a public
  // repository first keep everyone else from it, and froze it at their commit.)

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
