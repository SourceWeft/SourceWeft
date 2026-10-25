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
 * and which apply at all depend on the kind of entry (see each rule's
 * `requiredWhen` and `applicableWhen`). The grade stays on the API for
 * existing readers; the public page shows the percentage and the checklist.
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
  /** When the score is computed; freshness is measured from here. */
  now?: Date;
};

/** The facts the items are decided from, read once from the source. */
type McpScoreFacts = {
  hasRemoteEndpoint: boolean;
  /** The endpoint answered an unauthenticated `initialize` at the last probe. */
  listableAnonymously: boolean;
  /** A stored probe classified the endpoint (open, credential or OAuth), whatever its age. */
  probeClassified: boolean;
  /** The registry entry declares how to authenticate (a type, a method or a header). */
  authMethodDeclared: boolean;
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
  /**
   * A remote endpoint with no package or repository to run or read: the
   * license of such a service is not the listing's to declare.
   */
  hostedOnly: boolean;
};

type McpScoreRule = {
  key: MarketMcpScoreItemKey;
  weight: number;
  /** False when the item does not apply to this entry; it then leaves the total. */
  applicableWhen: (facts: McpScoreFacts) => boolean;
  requiredWhen: (facts: McpScoreFacts) => boolean;
  met: (facts: McpScoreFacts) => boolean;
};

const ALWAYS = () => true;
const NEVER = () => false;

/**
 * The items, in the order the page lists them. Weights sum to 100. Identity
 * (the claim, the publisher's domain) is shown as badges and is not here:
 * the score is how complete the listing's data is.
 */
export const MCP_SCORE_RULES: readonly McpScoreRule[] = [
  {
    key: "reachable",
    weight: 25,
    applicableWhen: ALWAYS,
    requiredWhen: (facts) => facts.hasRemoteEndpoint,
    met: (facts) => facts.probeFresh || facts.validationFresh,
  },
  {
    key: "authDeclared",
    weight: 10,
    applicableWhen: ALWAYS,
    requiredWhen: (facts) => facts.hasRemoteEndpoint,
    // A posture alone says little: federation writes one for every remote,
    // "none" included, so it counts only when something backs it — a probe
    // that classified the endpoint, or headers/OAuth the entry declares.
    met: (facts) =>
      facts.authPostureKnown &&
      (facts.probeClassified || facts.authMethodDeclared),
  },
  {
    key: "hasTools",
    weight: 15,
    applicableWhen: ALWAYS,
    requiredWhen: (facts) =>
      facts.listableAnonymously || facts.validatedStdioPackage,
    met: (facts) => facts.toolCount >= 1,
  },
  {
    key: "hasDescription",
    weight: 15,
    applicableWhen: ALWAYS,
    requiredWhen: ALWAYS,
    met: (facts) =>
      facts.descriptionChars >= MCP_SCORE_MIN_DESCRIPTION_CHARS ||
      facts.hasAiOverview ||
      facts.hasOwnerDescription,
  },
  {
    key: "hasLogo",
    weight: 10,
    applicableWhen: ALWAYS,
    requiredWhen: NEVER,
    met: (facts) => facts.hasIcon,
  },
  {
    key: "hasDocs",
    weight: 15,
    applicableWhen: ALWAYS,
    requiredWhen: NEVER,
    met: (facts) =>
      facts.readmeFetched ||
      facts.hasResourceDocumentation ||
      facts.hasOwnerDocumentation,
  },
  {
    key: "hasLicense",
    weight: 10,
    // A hosted service is used under its provider's terms, not a license the
    // listing could carry: not applicable, so it neither earns nor costs.
    applicableWhen: (facts) => !facts.hostedOnly,
    requiredWhen: NEVER,
    met: (facts) => facts.licenseKnown,
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

/**
 * True when `value` is an ISO time inside the freshness window at `now`: the
 * same `0 ≤ age < 30 days` the probe writer uses to reuse a stored probe, so
 * a probe the sync would redo no longer counts, and a time in the future (a
 * clock gone wrong) never does.
 */
function fresh(value: unknown, now: Date): boolean {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at)) return false;
  const age = now.getTime() - at;
  return age >= 0 && age < MCP_SCORE_FRESHNESS_MS;
}

const PROBE_RESULTS = new Set(["open", "credential", "oauth"]);
const AUTH_POSTURES = new Set(["none", "optional", "required"]);

/** Collapse whitespace so a description padded with newlines counts its words. */
function visibleChars(value: string) {
  return value.replace(/\s+/g, " ").trim().length;
}

/**
 * True when the registry entry lists remotes and nothing to install or read:
 * no package, no repository. Read from what the entry says about how it is
 * delivered; an entry that says nothing (a submission, a row from before
 * `registryServer` was kept) is not hosted-only, so the license applies.
 */
function isHostedOnly(input: {
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

export function mcpScoreFacts(source: McpScoreSource): McpScoreFacts {
  const now = source.now ?? new Date();
  const manifest = record(source.manifestJson) ?? {};
  const provenance = record(source.provenanceJson) ?? {};
  const auth = record(manifest.auth);
  const authProbe = record(provenance.authProbe);
  const owner = record(manifest.owner);
  const registryServer = record(provenance.registryServer);
  const authMetadata = record(provenance.authMetadata);
  const githubRegistry = record(provenance.githubRegistry);
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];

  const hasRemoteEndpoint = isHttpUrl(manifest.endpointUrl);
  const probeResult = text(authProbe?.result);
  const probeClassified =
    probeResult !== null && PROBE_RESULTS.has(probeResult);
  const probeFresh = probeClassified && fresh(authProbe?.probedAt, now);
  const validationFresh = fresh(provenance.validatedAt, now);
  // The description only: federation fills `summary` with a placeholder
  // ("MCP server <identifier> from the MCP registry.") that is long enough
  // for nearly every identifier, so it would pass an entry that says nothing.
  const description = text(manifest.description) ?? "";
  const authType = text(auth?.type);
  const authMethods = Array.isArray(auth?.methods) ? auth.methods : [];
  const allowedHeaderNames = Array.isArray(auth?.allowedHeaderNames)
    ? auth.allowedHeaderNames
    : [];
  const iconSource = text(source.iconSource) ?? text(manifest.iconSource);

  return {
    hasRemoteEndpoint,
    listableAnonymously: hasRemoteEndpoint && probeResult === "open",
    probeClassified,
    authMethodDeclared:
      (authType !== null && authType !== "none") ||
      authMethods.length > 0 ||
      allowedHeaderNames.length > 0,
    validatedStdioPackage:
      !hasRemoteEndpoint && text(provenance.validatedAt) !== null,
    probeFresh,
    validationFresh,
    authPostureKnown: AUTH_POSTURES.has(text(auth?.posture) ?? ""),
    toolCount: tools.length,
    descriptionChars: visibleChars(description),
    hasAiOverview: source.hasAiOverview === true,
    // The manifest the read passes already carries the verified owner's
    // corrections (W7): a description they wrote counts however short.
    hasOwnerDescription:
      Array.isArray(owner?.fields) &&
      owner.fields.includes("description") &&
      description.length > 0,
    hasIcon:
      (iconSource !== null && iconSource !== "placeholder") ||
      isHttpUrl(manifest.iconUrl) ||
      isHttpUrl(source.iconUrl),
    readmeFetched: source.readmeStatus === "ok",
    hasResourceDocumentation: isHttpUrl(authMetadata?.resourceDocumentation),
    hasOwnerDocumentation: isHttpUrl(manifest.documentationUrl),
    licenseKnown:
      text(manifest.license) !== null || text(githubRegistry?.license) !== null,
    hostedOnly:
      hasRemoteEndpoint &&
      isHostedOnly({ manifest, provenance, registryServer }),
  };
}

/** The grade of a percentage when every required item is met. */
export function mcpScoreGrade(percentage: number): MarketMcpScoreGrade {
  if (percentage >= MCP_SCORE_GRADE_A_MIN_PERCENTAGE) return "A";
  if (percentage >= MCP_SCORE_GRADE_B_MIN_PERCENTAGE) return "B";
  return "F";
}

/**
 * The scorecard of one catalog entry; see the module comment. The percentage
 * is the weight met of the weight that applies: an item that does not apply
 * to the entry is listed, marked, and left out of both.
 */
export function scoreMcp(source: McpScoreSource): MarketMcpScore {
  const facts = mcpScoreFacts(source);
  const items: MarketMcpScoreItem[] = MCP_SCORE_RULES.map((rule) => {
    const applicable = rule.applicableWhen(facts);
    return {
      key: rule.key,
      weight: rule.weight,
      applicable,
      required: applicable && rule.requiredWhen(facts),
      met: applicable && rule.met(facts),
    };
  });
  const applicableWeight = items.reduce(
    (sum, item) => sum + (item.applicable ? item.weight : 0),
    0,
  );
  const metWeight = items.reduce(
    (sum, item) => sum + (item.met ? item.weight : 0),
    0,
  );
  const percentage =
    applicableWeight > 0 ? Math.round((metWeight / applicableWeight) * 100) : 0;
  const requiredMet = items.every((item) => item.met || !item.required);
  return {
    grade: requiredMet ? mcpScoreGrade(percentage) : "F",
    percentage,
    items,
  };
}
