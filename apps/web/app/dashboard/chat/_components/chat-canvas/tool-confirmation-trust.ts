import {
  AGENT_TOOL_TRUST_RULE_DEFAULT_TTL_SECONDS,
  AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS,
  type AgentToolTrustRule,
  type ToolConfirmationDecision,
  type ToolConfirmationRequest,
} from "@sourceweft/sdk";

/**
 * The decision buttons a confirmation card may show and the "remember this"
 * affordance that rides along with one of them.
 *
 * Everything here is derived from the confirmation the server sent. The card
 * never invents a decision: a surface that does not list `approve_always` in
 * `decisionOptions` is a surface where no standing approval can be created, and
 * the button must not appear there.
 */

export type ToolConfirmationDecisionOption = {
  decision: ToolConfirmationDecision;
  label: string;
  description?: string;
};

/**
 * Fallback used only when a confirmation arrives without `decisionOptions` —
 * older payloads and hand-built fixtures. It deliberately contains just the two
 * decisions that have always existed, so a missing field can never be the
 * reason a standing-approval button appears.
 */
const fallbackDecisionOptions: ToolConfirmationDecisionOption[] = [
  { decision: "reject", label: "Reject" },
  { decision: "approve", label: "Approve" },
];

export function getConfirmationDecisionOptions(
  confirmation: Pick<ToolConfirmationRequest, "decisionOptions">,
): ToolConfirmationDecisionOption[] {
  const options = confirmation.decisionOptions;
  if (!Array.isArray(options) || options.length === 0) {
    return fallbackDecisionOptions;
  }
  return options;
}

export function hasAlwaysAllowOption(
  confirmation: Pick<ToolConfirmationRequest, "decisionOptions">,
) {
  return getConfirmationDecisionOptions(confirmation).some(
    (option) => option.decision === "approve_always",
  );
}

const SECONDS_PER_DAY = 24 * 60 * 60;

function formatDays(seconds: number) {
  const days = Math.max(1, Math.round(seconds / SECONDS_PER_DAY));
  return `${days} day${days === 1 ? "" : "s"}`;
}

export type TrustDurationChoice = {
  id: string;
  label: string;
  /** `undefined` means "send no ttlSeconds and let the server apply its default". */
  ttlSeconds?: number;
};

/**
 * Durations offered next to "Always allow".
 *
 * The default and the maximum are read from the contract rather than restated
 * here, because the server clamps against exactly those two numbers. The
 * shorter presets are a UI convenience — the wire format explicitly allows a
 * caller to ask for less — and are filtered against the contract maximum so a
 * future narrowing of the cap cannot leave a dead option on screen.
 */
const allTrustDurationChoices: TrustDurationChoice[] = [
  {
    id: "default",
    label: `${formatDays(AGENT_TOOL_TRUST_RULE_DEFAULT_TTL_SECONDS)} (default)`,
  },
  { id: "1d", label: formatDays(SECONDS_PER_DAY), ttlSeconds: SECONDS_PER_DAY },
  {
    id: "7d",
    label: formatDays(7 * SECONDS_PER_DAY),
    ttlSeconds: 7 * SECONDS_PER_DAY,
  },
  {
    id: "max",
    label: `${formatDays(AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS)} (maximum)`,
    ttlSeconds: AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS,
  },
];

export const trustDurationChoices = allTrustDurationChoices.filter(
  (choice) =>
    choice.ttlSeconds === undefined ||
    choice.ttlSeconds <= AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS,
);

export const defaultTrustDurationChoiceId = "default";

/**
 * Builds the `trust` payload for an `approve_always` response.
 *
 * `scope` is intentionally never sent. Confirmations are not given a target at
 * propose time, so asking for target granularity silently degrades to a
 * tool-wide grant — a narrower-sounding request that produces a wider rule is
 * the one thing this feature must not do.
 */
export function buildTrustPayload(choiceId: string) {
  const choice = trustDurationChoices.find(
    (candidate) => candidate.id === choiceId,
  );
  return typeof choice?.ttlSeconds === "number"
    ? { ttlSeconds: choice.ttlSeconds }
    : {};
}

export function formatTrustRuleExpiry(
  expiresAt: string | null | undefined,
  now = new Date(),
) {
  if (!expiresAt) {
    return null;
  }
  const parsed = new Date(expiresAt);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) {
    return null;
  }
  if (time <= now.getTime()) {
    return "expired";
  }
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * The message shown after a decision settles.
 *
 * The only signal that a standing approval exists is the `trustRule` the server
 * returned. `approve_always` degrades to a plain approve whenever the server
 * cannot resolve a scope it would be able to match again (MCP tool calls, tools
 * with no declared risk level), and in that case the user must be told the
 * approval was one-off — claiming otherwise would leave them believing in a
 * grant that does not exist and that no settings screen could show them.
 */
export function describeDecisionOutcome(input: {
  decision: ToolConfirmationDecision;
  trustRule?: AgentToolTrustRule | null;
  now?: Date;
}) {
  if (input.decision === "reject") {
    return "Rejected in SourceWeft. The action was not run.";
  }
  if (input.decision !== "approve_always") {
    return "Approved in SourceWeft.";
  }
  if (!input.trustRule) {
    return "Approved in SourceWeft. This approval was not remembered — it applies to this action only.";
  }
  const expiry = formatTrustRuleExpiry(
    input.trustRule.expiresAt,
    input.now ?? new Date(),
  );
  return expiry
    ? `Approved in SourceWeft. This action will be approved automatically until ${expiry}. Manage it in Settings → Approvals.`
    : "Approved in SourceWeft. This action will be approved automatically. Manage it in Settings → Approvals.";
}
