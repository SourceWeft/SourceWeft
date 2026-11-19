/**
 * Stage 4 — Guard (triage). Pure decision, no IO.
 * docs/architecture/skill-registry-index.md §3 Stage 4 / build phase R2.
 *
 * Every submission ends in one of three states, and only the last needs a
 * person:
 *
 *   - indexed  — a scan that found nothing hostile. Version published. Flags
 *                that merely describe what a skill does are shown on its page.
 *   - refused  — a scan that found the attack itself (`REFUSED_SCAN_FLAGS`), or
 *                a skill a person already took down. Nothing is stored; the
 *                submitter is told why. Waiting for review would only fill the
 *                queue.
 *   - queued   — a flag the scan does not know. Version draft, for an admin.
 *
 * No ownership veto: anyone may submit a newer commit of the same public
 * repository (see below). Control of the listing is not decided here.
 *
 * A person's decision sticks: once an admin deprecated or disabled the
 * latest version, or the definition is archived, a later commit that merely
 * drops the risky lines cannot bring it back — only an admin moves it. A draft
 * does NOT stick: it is the scan's own hold, and a clean later commit of the
 * same skill has answered it.
 */

import { refusedScanFlags } from "./scan";

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

export type TriageDecision =
  | {
      /** Maps to the submit-response status (`indexed` | `queued`). */
      outcome: "indexed" | "queued";
      versionStatus: "published" | "draft";
      definitionStatus: "active";
      reasons: string[];
    }
  | {
      /** Reported to the submitter as a failure; nothing is stored. */
      outcome: "refused";
      reasons: string[];
    };

/** Why a person's earlier decision holds a skill, or null when none does. */
function heldBy(
  existing: NonNullable<RegistryExistingEntry>,
): "archived" | "disabled" | "deprecated" | null {
  if (existing.definitionStatus === "archived") return "archived";
  if (existing.currentVersionStatus === "disabled") return "disabled";
  if (existing.currentVersionStatus === "deprecated") return "deprecated";
  return null;
}

/** The submitter-facing sentence for a refusal. */
export function describeRefusal(reasons: string[]): string {
  const held = reasons.find((reason) => reason.startsWith("held:"));
  if (held) {
    return `This skill was ${held.slice("held:".length)} by an admin, so new commits of it are not indexed`;
  }
  return `The scan found content that is not indexed: ${reasons.join(", ")}`;
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

  const held = existing ? heldBy(existing) : null;
  if (held) {
    return { outcome: "refused", reasons: [`held:${held}`] };
  }
  const refused = refusedScanFlags(scan.flags);
  if (refused.length > 0) {
    return { outcome: "refused", reasons: refused };
  }

  return {
    outcome: scan.reviewRequired ? "queued" : "indexed",
    versionStatus: scan.reviewRequired ? "draft" : "published",
    definitionStatus: "active",
    reasons: scan.reviewRequired ? [...scan.flags] : [],
  };
}
