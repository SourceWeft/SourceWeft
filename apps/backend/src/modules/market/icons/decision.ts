import type {
  IconCandidate,
  IconCandidateSource,
  IconDecision,
} from "./dry-run-types";
import type { SiteTrust } from "./site-trust";

/**
 * Which candidate the new rules would show (Issue #367 dry-run), from the
 * ACCEPTED candidates only. Identity evidence ranks first: a tier A candidate
 * beats a tier B one; within a tier the product-specific declarations the
 * listing itself makes come before the publisher's site, which comes before
 * avatars and favicon-service copies. A site icon therefore never outranks a
 * registry icon of the same tier. Tier C candidates and images flagged as a
 * likely template are never picked; with nothing eligible the answer is the
 * letter placeholder. Candidates of different images among the eligible are
 * reported as `disagreement` for the reviewer — without a vision judge the
 * rules do not decide which of two different logos is right, they pick by
 * evidence and flag it.
 */

export const SOURCE_PRIORITY: readonly IconCandidateSource[] = [
  "registry",
  "server-info",
  "site",
  "github-avatar",
  "github-registry",
  "favicon",
];

const TEMPLATE_SIGNAL = "shared-template:";

type Eligible = IconCandidate & {
  sha256: string;
  storedUrl: string;
  width: number;
  height: number;
  tier: "A" | "B";
};

function isEligible(candidate: IconCandidate): candidate is Eligible {
  return (
    !candidate.rejection &&
    Boolean(candidate.sha256 && candidate.storedUrl) &&
    candidate.width !== undefined &&
    candidate.height !== undefined &&
    (candidate.tier === "A" || candidate.tier === "B") &&
    !candidate.signals?.some((signal) => signal.startsWith(TEMPLATE_SIGNAL))
  );
}

export function decideIcon(input: {
  site: SiteTrust;
  candidates: IconCandidate[];
  current: IconDecision["current"];
  now: Date;
}): IconDecision {
  const site: IconDecision["site"] =
    input.site.tier === "A" || input.site.tier === "B"
      ? {
          tier: input.site.tier,
          host: input.site.host,
          domain: input.site.domain,
          reasons: input.site.reasons,
        }
      : { tier: input.site.tier, reasons: input.site.reasons };
  const base = {
    version: 1 as const,
    decidedAt: input.now.toISOString(),
    site,
    current: input.current,
  };
  const eligible = input.candidates.filter(isEligible).sort((a, b) => {
    if (a.tier !== b.tier) return a.tier < b.tier ? -1 : 1;
    const bySource = SOURCE_PRIORITY.indexOf(a.source) - SOURCE_PRIORITY.indexOf(b.source);
    if (bySource !== 0) return bySource;
    return b.width * b.height - a.width * a.height;
  });
  const pick = eligible[0];
  if (!pick) {
    const accepted = input.candidates.filter(
      (candidate) => !candidate.rejection && candidate.sha256,
    );
    const reasons: string[] = [];
    if (input.candidates.length === 0) reasons.push("no-candidates");
    else if (accepted.length === 0) reasons.push("no-accepted-candidate");
    else {
      if (accepted.some((c) => c.signals?.some((s) => s.startsWith(TEMPLATE_SIGNAL)))) {
        reasons.push("shared-template-needs-review");
      }
      if (accepted.every((c) => c.tier === "C")) reasons.push("only-tier-c");
    }
    return { ...base, outcome: "placeholder", reasons, disagreement: false };
  }
  return {
    ...base,
    outcome: "pick",
    pick: {
      source: pick.source,
      url: pick.url,
      sha256: pick.sha256,
      storedUrl: pick.storedUrl,
      width: pick.width,
      height: pick.height,
      tier: pick.tier,
    },
    reasons: [`${pick.source}:tier-${pick.tier}`],
    disagreement: eligible.some((c) => c.sha256 !== pick.sha256),
  };
}

/** Whether the icon the pages show today differs from what the decision picks. */
export function decisionDiffers(decision: IconDecision) {
  const { current, pick } = decision;
  if (!pick) return current.iconSource !== "placeholder";
  return pick.source !== current.iconSource || pick.url !== current.iconUrl;
}
