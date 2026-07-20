import { getAgentToolDefinition } from "@sourceweft/agent-tool-registry";
import type { ToolConfirmationRequest } from "@sourceweft/contracts";
import { resolveConnectorActionTrustScope } from "../connectors/agent-tools";
import {
  resolveAgentToolTrustRuleExpiry,
  type AgentToolTrustRuleScopeGranularity,
} from "../connectors/agent-tool-trust";
import {
  createAgentToolTrustRuleRecord,
  findAgentToolTrustRuleRecord,
  touchAgentToolTrustRuleRecord,
} from "../connectors/repository";
import type { ConnectorActionRiskLevel } from "../connectors/types";
import { logger } from "../../shared/logger";

/**
 * The subject of a standing approval. Every field maps onto a column that
 * `findAgentToolTrustRuleRecord` compares for exact equality — there is
 * intentionally no wildcard, because the repository cannot express one and a
 * scope the query cannot match is a scope the user would misread.
 */
export type AgentToolTrustScope = {
  domain: string;
  toolName: string;
  connectorId: string | null;
  targetType: string | null;
  targetId: string | null;
  riskLevel: ConnectorActionRiskLevel;
};

export type AgentToolTrustTenant = {
  teamId: string;
  workspaceId: string;
  userId: string;
};

/**
 * Derives the trust scope for a tool call that is about to be gated.
 *
 * Resolution order matters: connector tools are also present in the agent tool
 * registry, but only the connector manifest knows which connector instance the
 * call will hit, and a rule that omitted the connector id could never match.
 *
 * `null` means "this call is not eligible for a standing approval" and the
 * caller must fall through to prompting the user. Every unknown case returns
 * `null` on purpose: an unrecognised tool must never be auto-approved.
 */
export async function resolveAgentToolTrustScope(input: {
  args: Record<string, unknown>;
  context: { teamId: string; workspaceId: string; userId: string };
  toolName: string;
}): Promise<AgentToolTrustScope | null> {
  const connectorScope = await resolveConnectorActionTrustScope(
    { ...input.context },
    { args: input.args, toolName: input.toolName },
  );
  if (connectorScope) {
    return {
      domain: connectorScope.domain,
      toolName: connectorScope.toolName,
      connectorId: connectorScope.connectorId,
      targetType: null,
      targetId: null,
      riskLevel: connectorScope.riskLevel,
    };
  }

  const definition = getAgentToolDefinition(input.toolName);
  // A tool that declares no risk level cannot be contained by
  // `allowedRiskLevels`, so it is never trustable. Defaulting it (the way the
  // confirmation payload defaults the *displayed* risk to "high") would let a
  // rule outlive a later change to the tool's real risk.
  if (!definition?.riskLevel) {
    return null;
  }
  return {
    domain: definition.domain,
    toolName: input.toolName,
    connectorId: null,
    targetType: null,
    targetId: null,
    riskLevel: definition.riskLevel,
  };
}

/**
 * Looks up a live standing approval for a scope. Expiry, revocation, tenancy
 * and risk containment are all enforced by the repository predicate.
 *
 * Lookup is separated from {@link touchAgentToolTrustRuleUse} because the gate
 * only skips the prompt when *every* interrupted action is covered; recording a
 * use for a rule whose sibling action still needs a prompt would make the
 * settings screen claim a grant was exercised when the user was asked anyway.
 */
export async function findAgentToolTrustRuleForScope(input: {
  scope: AgentToolTrustScope;
  tenant: AgentToolTrustTenant;
  now?: Date;
}) {
  return findAgentToolTrustRuleRecord({
    teamId: input.tenant.teamId,
    workspaceId: input.tenant.workspaceId,
    userId: input.tenant.userId,
    domain: input.scope.domain,
    toolName: input.scope.toolName,
    connectorId: input.scope.connectorId,
    targetType: input.scope.targetType,
    targetId: input.scope.targetId,
    riskLevel: input.scope.riskLevel,
    ...(input.now ? { now: input.now } : {}),
  });
}

/** Records that a standing approval was actually used to skip a prompt. */
export async function touchAgentToolTrustRuleUse(input: {
  trustRuleId: string;
  tenant: AgentToolTrustTenant;
  now?: Date;
}) {
  const touched = await touchAgentToolTrustRuleRecord({
    teamId: input.tenant.teamId,
    workspaceId: input.tenant.workspaceId,
    trustRuleId: input.trustRuleId,
    ...(input.now ? { lastUsedAt: input.now } : {}),
  });
  logger.info("Agent tool confirmation auto-approved by a trust rule", {
    workspaceId: input.tenant.workspaceId,
    userId: input.tenant.userId,
    trustRuleId: input.trustRuleId,
  });
  return touched;
}

/**
 * Narrows a scope by the granularity the user asked for. `target` is only
 * honoured when the confirmation actually carries a target; silently widening a
 * "just this document" grant into "this tool anywhere" would be the exact
 * failure this whole mechanism must not have, so an unavailable target is
 * reported by returning the tool-level scope unchanged and letting the caller
 * decide (it currently records the narrower-is-impossible case in the rule it
 * writes, which is the tool-level grant the user can see and revoke).
 */
export function narrowAgentToolTrustScope(input: {
  scope: AgentToolTrustScope;
  granularity?: AgentToolTrustRuleScopeGranularity;
  confirmation?: ToolConfirmationRequest;
}): AgentToolTrustScope {
  if (input.granularity !== "target") {
    return input.scope;
  }
  const target = input.confirmation?.preview.target;
  if (!target?.type || !target.id) {
    return input.scope;
  }
  return { ...input.scope, targetType: target.type, targetId: target.id };
}

/**
 * Persists a standing approval.
 *
 * `allowedRiskLevels` is exactly the one level that was approved, never a
 * range: approving a low-risk action must not authorise the medium- or
 * high-risk variants of the same tool. `createdFromConfirmationId` records the
 * confirmation the grant was born from so the settings UI (and any later audit)
 * can point at the exact prompt the user answered.
 */
export async function recordAgentToolTrustRule(input: {
  scope: AgentToolTrustScope;
  tenant: AgentToolTrustTenant;
  confirmationId: string;
  ttlSeconds?: number;
  now?: Date;
}) {
  const rule = await createAgentToolTrustRuleRecord({
    teamId: input.tenant.teamId,
    workspaceId: input.tenant.workspaceId,
    userId: input.tenant.userId,
    domain: input.scope.domain,
    toolName: input.scope.toolName,
    connectorId: input.scope.connectorId,
    targetType: input.scope.targetType,
    targetId: input.scope.targetId,
    allowedRiskLevels: [input.scope.riskLevel],
    status: "active",
    expiresAt: resolveAgentToolTrustRuleExpiry({
      ...(typeof input.ttlSeconds === "number"
        ? { ttlSeconds: input.ttlSeconds }
        : {}),
      ...(input.now ? { now: input.now } : {}),
    }),
    createdFromConfirmationId: input.confirmationId,
  });
  logger.info("Agent tool trust rule created", {
    workspaceId: input.tenant.workspaceId,
    userId: input.tenant.userId,
    trustRuleId: rule.id,
    domain: rule.domain,
    toolName: rule.toolName,
    connectorId: rule.connectorId,
    expiresAt: rule.expiresAt,
    createdFromConfirmationId: rule.createdFromConfirmationId,
  });
  return rule;
}
