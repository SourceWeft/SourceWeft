import { formatDisplayDate } from "@/lib/i18n/format";
import {
  AGENT_TOOL_TRUST_RULE_DEFAULT_TTL_SECONDS,
  AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS,
  type AgentToolTrustRule,
  type ToolConfirmationDecision,
  type ToolConfirmationRequest,
} from "@sourceweft/sdk";
import type { useTranslations } from "next-intl";

type Translate = ReturnType<typeof useTranslations>;

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
function getFallbackDecisionOptions(
  t: Translate,
): ToolConfirmationDecisionOption[] {
  return [
    { decision: "reject", label: t("toolConfirmation.decision.reject") },
    { decision: "approve", label: t("toolConfirmation.decision.approve") },
  ];
}

export function getConfirmationDecisionOptions(
  confirmation: Pick<ToolConfirmationRequest, "decisionOptions">,
  t: Translate,
): ToolConfirmationDecisionOption[] {
  const options = confirmation.decisionOptions;
  if (!Array.isArray(options) || options.length === 0) {
    return getFallbackDecisionOptions(t);
  }
  return options;
}

export function hasAlwaysAllowOption(
  confirmation: Pick<ToolConfirmationRequest, "decisionOptions">,
) {
  // Checks decisions only, so it needs no translator: the fallback used when
  // `decisionOptions` is empty is always [reject, approve], which can never
  // contain `approve_always`.
  const options = confirmation.decisionOptions;
  if (!Array.isArray(options) || options.length === 0) {
    return false;
  }
  return options.some((option) => option.decision === "approve_always");
}

const SECONDS_PER_DAY = 24 * 60 * 60;

function formatDays(seconds: number, t: Translate) {
  const days = Math.max(1, Math.round(seconds / SECONDS_PER_DAY));
  return days === 1
    ? t("toolConfirmation.trustDuration.day", { count: days })
    : t("toolConfirmation.trustDuration.days", { count: days });
}

export type TrustDurationChoice = {
  id: string;
  label: string;
  /** `undefined` means "send no ttlSeconds and let the server apply its default". */
  ttlSeconds?: number;
};

type TrustDurationDef = {
  id: string;
  ttlSeconds?: number;
  kind: "default" | "plain" | "maximum";
  seconds: number;
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
const trustDurationDefs: TrustDurationDef[] = (
  [
    {
      id: "default",
      kind: "default",
      seconds: AGENT_TOOL_TRUST_RULE_DEFAULT_TTL_SECONDS,
    },
    {
      id: "1d",
      ttlSeconds: SECONDS_PER_DAY,
      kind: "plain",
      seconds: SECONDS_PER_DAY,
    },
    {
      id: "7d",
      ttlSeconds: 7 * SECONDS_PER_DAY,
      kind: "plain",
      seconds: 7 * SECONDS_PER_DAY,
    },
    {
      id: "max",
      ttlSeconds: AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS,
      kind: "maximum",
      seconds: AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS,
    },
  ] satisfies TrustDurationDef[]
).filter(
  (def) =>
    def.ttlSeconds === undefined ||
    def.ttlSeconds <= AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS,
);

export function getTrustDurationChoices(t: Translate): TrustDurationChoice[] {
  return trustDurationDefs.map((def) => {
    const days = formatDays(def.seconds, t);
    const label =
      def.kind === "default"
        ? t("toolConfirmation.trustDuration.default", { days })
        : def.kind === "maximum"
          ? t("toolConfirmation.trustDuration.maximum", { days })
          : days;
    return {
      id: def.id,
      label,
      ...(def.ttlSeconds === undefined ? {} : { ttlSeconds: def.ttlSeconds }),
    };
  });
}

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
  const def = trustDurationDefs.find((candidate) => candidate.id === choiceId);
  return typeof def?.ttlSeconds === "number"
    ? { ttlSeconds: def.ttlSeconds }
    : {};
}

export function formatTrustRuleExpiry(
  expiresAt: string | null | undefined,
  t: Translate,
  now = new Date(),
  displayLocale: string,
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
    return t("toolConfirmation.trustDuration.expired");
  }
  return formatDisplayDate(parsed, displayLocale, {
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
export function describeDecisionOutcome(
  input: {
    decision: ToolConfirmationDecision;
    trustRule?: AgentToolTrustRule | null;
    now?: Date;
  },
  t: Translate,
  displayLocale: string,
) {
  if (input.decision === "reject") {
    return t("toolConfirmation.rejectedNotRun");
  }
  if (input.decision !== "approve_always") {
    return t("toolConfirmation.approvedInSourceweft");
  }
  if (!input.trustRule) {
    return t("toolConfirmation.outcome.approvedNotRemembered");
  }
  const expiry = formatTrustRuleExpiry(
    input.trustRule.expiresAt,
    t,
    input.now ?? new Date(),
    displayLocale,
  );
  return expiry
    ? t("toolConfirmation.outcome.approvedUntil", { expiry })
    : t("toolConfirmation.outcome.approvedAlways");
}
