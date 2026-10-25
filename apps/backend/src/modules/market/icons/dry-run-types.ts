/**
 * The records of the icon dry-run (Issue #367), kept on a version's
 * provenance as `iconCandidates` and `iconDecision`. They change nothing the
 * public pages show: the displayed icon still comes from the logo chain
 * (`chain.ts`).
 */

export type IconCandidateSource =
  | "registry"
  | "server-info"
  | "github-avatar"
  | "github-registry"
  | "favicon"
  | "site";

/** How an official site declared a `site` candidate. */
export type SiteIconKind =
  | "apple-touch-icon"
  | "manifest-icon"
  | "icon"
  | "mask-icon"
  | "implicit-favicon";

export type IconTier = "A" | "B" | "C";

export type IconCandidate = {
  source: IconCandidateSource;
  /** Where the image was declared; for `favicon`, our stored copy of it. */
  url: string;
  kind?: SiteIconKind;
  /** Of the stored bytes; absent when the image never decoded. */
  sha256?: string;
  width?: number;
  height?: number;
  /** Our copy in the public bucket, for an accepted candidate. */
  storedUrl?: string;
  tier: IconTier;
  /** Why the candidate cannot be used; absent for an accepted one. */
  rejection?: string;
  /** Review signals on an ACCEPTED candidate, e.g. `shared-template:4`. */
  signals?: string[];
};

export type IconDecision = {
  version: 1;
  decidedAt: string;
  site: {
    tier: "A" | "B" | "C" | "none";
    host?: string;
    domain?: string;
    reasons: string[];
  };
  outcome: "pick" | "placeholder";
  /** The candidate the new rules would show; absent for a placeholder. */
  pick?: {
    source: IconCandidateSource;
    url: string;
    sha256: string;
    storedUrl: string;
    width: number;
    height: number;
    tier: "A" | "B";
  };
  /** Why: the rule that chose, or why nothing qualified. */
  reasons: string[];
  /** Other accepted A/B candidates whose image differs from the pick. */
  disagreement: boolean;
  /** What the pages show today, for the review sample's comparison. */
  current: { iconSource: string; iconUrl?: string };
};

/** What a stored dry-run record needs to say about the inputs it was made from. */
export type IconCandidatesRecord = {
  version: 1;
  checkedAt: string;
  /** Sorted candidate URLs and the site host: reuse the record while equal. */
  inputKey: string;
  /** False while a fetch was deferred or busy: the record is redone next sync. */
  complete: boolean;
  items: IconCandidate[];
};
