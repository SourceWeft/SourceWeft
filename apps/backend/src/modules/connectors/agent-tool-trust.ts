import {
  AGENT_TOOL_TRUST_RULE_DEFAULT_TTL_SECONDS,
  AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS,
} from "@sourceweft/contracts";
import type {
  AgentToolTrustRuleRecord,
  ConnectorActionRiskLevel,
} from "./types";

/**
 * Agent tool trust rules ("remember this approval") are a standing bypass of a
 * human approval gate. Everything in this file is deliberately pure so the
 * matching rules can be pinned by unit tests that do not need a database — the
 * SQL in `findAgentToolTrustRuleRecord` narrows for performance, but the
 * predicate below is what actually decides, so a future change to that query
 * cannot silently widen who a rule applies to.
 */

/**
 * A trust rule with no expiry is a permanent approval bypass. We never write
 * one: when the caller omits a TTL the server picks a bounded default so every
 * rule dies on its own even if the user never revisits the settings screen.
 *
 * The numbers live in `@sourceweft/contracts` so the client that offers the
 * duration and the server that clamps it cannot drift apart; they are
 * re-exported here because this file is where the clamping happens.
 */
export {
  AGENT_TOOL_TRUST_RULE_DEFAULT_TTL_SECONDS,
  AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS,
};

export type AgentToolTrustRuleScopeGranularity = "tool" | "target";

export type AgentToolTrustRuleMatchInput = {
  teamId: string;
  workspaceId: string;
  userId: string;
  domain: string;
  toolName: string;
  connectorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  riskLevel: ConnectorActionRiskLevel;
  now?: Date;
};

/**
 * Clamps a requested TTL into the allowed window and turns it into an absolute
 * instant. Returning a `Date` (never `null`) is the invariant: callers cannot
 * accidentally persist a never-expiring rule by passing `undefined`.
 */
export function resolveAgentToolTrustRuleExpiry(input: {
  ttlSeconds?: number;
  now?: Date;
}): Date {
  const now = input.now ?? new Date();
  const requested =
    typeof input.ttlSeconds === "number" && Number.isFinite(input.ttlSeconds)
      ? Math.floor(input.ttlSeconds)
      : AGENT_TOOL_TRUST_RULE_DEFAULT_TTL_SECONDS;
  const ttlSeconds = Math.min(
    Math.max(requested, 1),
    AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS,
  );
  return new Date(now.getTime() + ttlSeconds * 1000);
}

/**
 * The single decision point for "may this rule auto-approve this action?".
 *
 * Every clause here is load-bearing:
 * - team/workspace: a rule granted in one workspace must never approve an
 *   action in another, even if the same user is a member of both.
 * - user: trust is per-person; one member's grant is not the team's grant.
 * - status: a revoked rule must behave as if it were deleted.
 * - expiry: enforced at match time, not only at write time, because rows keep
 *   sitting in the table long after they stop being valid.
 * - connector/target: exact equality (including NULL === NULL). A rule for one
 *   connector or one target must not leak to a sibling.
 * - risk containment: the rule enumerates the risk levels it was granted for.
 *   Drop this and an approval of a low-risk read silently authorises a
 *   high-risk delete on the same tool.
 */
export function agentToolTrustRuleMatches(
  rule: AgentToolTrustRuleRecord,
  input: AgentToolTrustRuleMatchInput,
): boolean {
  if (rule.teamId !== input.teamId) return false;
  if (rule.workspaceId !== input.workspaceId) return false;
  if (rule.userId !== input.userId) return false;
  if (rule.domain !== input.domain) return false;
  if (rule.toolName !== input.toolName) return false;
  if (rule.status !== "active") return false;

  if (rule.connectorId !== (input.connectorId ?? null)) return false;
  if (rule.targetType !== (input.targetType ?? null)) return false;
  if (rule.targetId !== (input.targetId ?? null)) return false;

  if (rule.expiresAt) {
    const expiresAt = new Date(rule.expiresAt).getTime();
    const now = (input.now ?? new Date()).getTime();
    // An unparseable timestamp is treated as expired: failing closed is the only
    // safe direction for a bypass rule.
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  }

  return (
    Array.isArray(rule.allowedRiskLevels) &&
    rule.allowedRiskLevels.includes(input.riskLevel)
  );
}
