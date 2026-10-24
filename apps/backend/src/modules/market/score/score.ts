import type {
  MarketMcpScore,
  MarketMcpScoreGrade,
  MarketMcpScoreItem,
  MarketMcpScoreItemKey,
  McpReadmeStatus,
} from "@sourceweft/market-contracts";

/**
 * The quality scorecard of a catalog MCP entry (Issue #367, W6): how complete
 * its listing is, read from what the catalog already stores. Pure and
 * deterministic — the same rows and the same `now` give the same score — and
 * defensive: every field it reads may be absent (an entry from before the
 * field existed, a sibling workstream not yet landed), and absent means not
 * met.
 *
 * Modelled on LobeHub's public score: weighted items, some required, graded
 * A (≥ 80 % of the weight met), B (≥ 60 %) or F; a required item not met is
 * F whatever the percentage. The difference is that which items are required
 * depends on the kind of entry (see each rule's `requiredWhen`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A probe or validation older than this no longer proves the server answers. */
export const MCP_SCORE_FRESHNESS_MS = 30 * DAY_MS;
/** A description shorter than this says no more than the name does. */
export const MCP_SCORE_MIN_DESCRIPTION_CHARS = 40;
export const MCP_SCORE_GRADE_A_MIN_PERCENTAGE = 80;
export const MCP_SCORE_GRADE_B_MIN_PERCENTAGE = 60;

/** What the score is read from: the latest published version and its row. */
export type McpScoreSource = {
  /** The version's `manifest_json`. */
  manifestJson: unknown;
  /** The version's `provenance_json`. */
  provenanceJson: unknown;
  /** The version's README state; absent is treated as not fetched. */
  readmeStatus?: McpReadmeStatus | null;
  /** The version has a visible AI overview. */
  hasAiOverview?: boolean;
  /**
   * The icon the catalog shows for the entry (the summary's `iconUrl`),
   * which may be derived rather than stored; null when it shows a placeholder.
   */
  iconUrl?: string | null;
  /** Where that icon came from (the summary's `iconSource`, W3). */
  iconSource?: string | null;
  /** The entry's domain publisher as the catalog resolved it (the summary's `publisher`, W2). */
  publisher?: unknown;
  /** The owner claimed the entry and the claim was verified (W7). */
  claimed?: boolean;
  /** When the score is computed; freshness is measured from here. */
  now?: Date;
};

/** The facts the items are decided from, read once from the source. */
type McpScoreFacts = {
  hasRemoteEndpoint: boolean;
  /** The endpoint answered an unauthenticated `initialize` at the last probe. */
  listableAnonymously: boolean;
  /** A stdio package the sandbox started and listed (no remote owns the proof). */
  validatedStdioPackage: boolean;
  probeFresh: boolean;
  validationFresh: boolean;
  authPostureKnown: boolean;
  toolCount: number;
  descriptionChars: number;
  hasAiOverview: boolean;
  hasOwnerDescription: boolean;
  hasIcon: boolean;
  readmeFetched: boolean;
  hasResourceDocumentation: boolean;
  hasOwnerDocumentation: boolean;
  licenseKnown: boolean;
  endpointMatch: boolean;
  claimed: boolean;
};

type McpScoreRule = {
  key: MarketMcpScoreItemKey;
  weight: number;
  requiredWhen: (facts: McpScoreFacts) => boolean;
  met: (facts: McpScoreFacts) => boolean;
};

const ALWAYS = () => true;
const NEVER = () => false;

/** The items, in the order the page lists them. Weights sum to 100. */
export const MCP_SCORE_RULES: readonly McpScoreRule[] = [
  {
    key: "reachable",
    weight: 20,
    requiredWhen: (facts) => facts.hasRemoteEndpoint,
    met: (facts) => facts.probeFresh || facts.validationFresh,
  },
  {
    key: "authDeclared",
    weight: 10,
    requiredWhen: (facts) => facts.hasRemoteEndpoint,
    met: (facts) => facts.authPostureKnown,
  },
  {
    key: "hasTools",
    weight: 15,
    requiredWhen: (facts) =>
      facts.listableAnonymously || facts.validatedStdioPackage,
    met: (facts) => facts.toolCount >= 1,
  },
  {
    key: "hasDescription",
    weight: 10,
    requiredWhen: ALWAYS,
    met: (facts) =>
      facts.descriptionChars >= MCP_SCORE_MIN_DESCRIPTION_CHARS ||
      facts.hasAiOverview ||
      facts.hasOwnerDescription,
  },
  {
    key: "hasLogo",
    weight: 8,
    requiredWhen: NEVER,
    met: (facts) => facts.hasIcon,
  },
  {
    key: "hasDocs",
    weight: 10,
    requiredWhen: NEVER,
    met: (facts) =>
      facts.readmeFetched ||
      facts.hasResourceDocumentation ||
      facts.hasOwnerDocumentation,
  },
  {
    key: "hasLicense",
    weight: 7,
    requiredWhen: NEVER,
    met: (facts) => facts.licenseKnown,
  },
  {
    key: "officialPublisher",
    weight: 10,
    requiredWhen: NEVER,
    met: (facts) => facts.endpointMatch,
  },
  {
    key: "claimed",
    weight: 10,
    requiredWhen: NEVER,
    met: (facts) => facts.claimed,
  },
];

export const MCP_SCORE_TOTAL_WEIGHT = MCP_SCORE_RULES.reduce(
  (sum, rule) => sum + rule.weight,
  0,
);

// --- Defensive readers -----------------------------------------------------

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

/** True when `value` is an ISO time no older than the freshness window at `now`. */
function fresh(value: unknown, now: Date): boolean {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at <= MCP_SCORE_FRESHNESS_MS;
}

const PROBE_RESULTS = new Set(["open", "credential", "oauth"]);
const AUTH_POSTURES = new Set(["none", "optional", "required"]);

/** Collapse whitespace so a description padded with newlines counts its words. */
function visibleChars(value: string) {
  return value.replace(/\s+/g, " ").trim().length;
}

export function mcpScoreFacts(source: McpScoreSource): McpScoreFacts {
  const now = source.now ?? new Date();
  const manifest = record(source.manifestJson) ?? {};
  const provenance = record(source.provenanceJson) ?? {};
  const auth = record(manifest.auth);
  const authProbe = record(provenance.authProbe);
  const publisher = record(source.publisher) ?? record(manifest.publisher);
  const authMetadata = record(provenance.authMetadata);
  const githubRegistry = record(provenance.githubRegistry);
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];

  const hasRemoteEndpoint = isHttpUrl(manifest.endpointUrl);
  const probeResult = text(authProbe?.result);
  const probeFresh =
    probeResult !== null &&
    PROBE_RESULTS.has(probeResult) &&
    fresh(authProbe?.probedAt, now);
  const validationFresh = fresh(provenance.validatedAt, now);
  const description = text(manifest.description) ?? "";
  const summary = text(manifest.summary) ?? "";
  const iconSource = text(source.iconSource) ?? text(manifest.iconSource);

  return {
    hasRemoteEndpoint,
    listableAnonymously: hasRemoteEndpoint && probeResult === "open",
    validatedStdioPackage:
      !hasRemoteEndpoint && text(provenance.validatedAt) !== null,
    probeFresh,
    validationFresh,
    authPostureKnown: AUTH_POSTURES.has(text(auth?.posture) ?? ""),
    toolCount: tools.length,
    descriptionChars: Math.max(
      visibleChars(description),
      visibleChars(summary),
    ),
    hasAiOverview: source.hasAiOverview === true,
    // An owner-written description arrives with owner claims (W7).
    hasOwnerDescription: false,
    hasIcon:
      (iconSource !== null && iconSource !== "placeholder") ||
      isHttpUrl(manifest.iconUrl) ||
      isHttpUrl(source.iconUrl),
    readmeFetched: source.readmeStatus === "ok",
    hasResourceDocumentation: isHttpUrl(authMetadata?.resourceDocumentation),
    // An owner-set documentation link arrives with owner claims (W7).
    hasOwnerDocumentation: false,
    licenseKnown:
      text(manifest.license) !== null || text(githubRegistry?.license) !== null,
    endpointMatch: publisher?.endpointMatch === true,
    claimed: source.claimed === true,
  };
}

/** The grade of a percentage when every required item is met. */
export function mcpScoreGrade(percentage: number): MarketMcpScoreGrade {
  if (percentage >= MCP_SCORE_GRADE_A_MIN_PERCENTAGE) return "A";
  if (percentage >= MCP_SCORE_GRADE_B_MIN_PERCENTAGE) return "B";
  return "F";
}

/** The scorecard of one catalog entry; see the module comment. */
export function scoreMcp(source: McpScoreSource): MarketMcpScore {
  const facts = mcpScoreFacts(source);
  const items: MarketMcpScoreItem[] = MCP_SCORE_RULES.map((rule) => ({
    key: rule.key,
    weight: rule.weight,
    required: rule.requiredWhen(facts),
    met: rule.met(facts),
  }));
  const metWeight = items.reduce(
    (sum, item) => sum + (item.met ? item.weight : 0),
    0,
  );
  const percentage = Math.round((metWeight / MCP_SCORE_TOTAL_WEIGHT) * 100);
  const requiredMet = items.every((item) => item.met || !item.required);
  return {
    grade: requiredMet ? mcpScoreGrade(percentage) : "F",
    percentage,
    items,
  };
}
