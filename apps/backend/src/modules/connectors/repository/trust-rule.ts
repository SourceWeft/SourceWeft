/**
 * Persistence for agent tool trust rules — the per-user standing approvals that
 * let an agent tool call skip its human confirmation gate.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { agentToolTrustRules, db } from "@sourceweft/db";
import { agentToolTrustRuleMatches } from "../agent-tool-trust";
import { ConnectorError } from "../errors";
import { mapAgentToolTrustRule } from "../mappers";
import type {
  AgentToolTrustRuleStatus,
  ConnectorActionRiskLevel,
} from "../types";

export async function findAgentToolTrustRuleRecord(input: {
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
}) {
  const now = input.now ?? new Date();
  const rows = await db
    .select()
    .from(agentToolTrustRules)
    .where(
      and(
        eq(agentToolTrustRules.teamId, input.teamId),
        eq(agentToolTrustRules.workspaceId, input.workspaceId),
        eq(agentToolTrustRules.userId, input.userId),
        eq(agentToolTrustRules.domain, input.domain),
        eq(agentToolTrustRules.toolName, input.toolName),
        eq(agentToolTrustRules.status, "active"),
      ),
    )
    .orderBy(desc(agentToolTrustRules.createdAt))
    .limit(50);

  // The WHERE clause above narrows using the scope index; it is not the
  // authority. `agentToolTrustRuleMatches` re-asserts every tenancy, status and
  // expiry condition on the mapped record so that a future edit to the query
  // (or a new index-driven rewrite) cannot widen which rules auto-approve.
  const match = rows
    .map(mapAgentToolTrustRule)
    .find((rule) => agentToolTrustRuleMatches(rule, { ...input, now }));

  return match ?? null;
}

export async function listAgentToolTrustRuleRecords(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  status?: AgentToolTrustRuleStatus;
}) {
  const rows = await db
    .select()
    .from(agentToolTrustRules)
    .where(
      and(
        eq(agentToolTrustRules.teamId, input.teamId),
        eq(agentToolTrustRules.workspaceId, input.workspaceId),
        // Scoped to the owning user as well as the workspace: a trust rule is a
        // personal grant, so one member must not be able to enumerate another
        // member's standing approvals.
        eq(agentToolTrustRules.userId, input.userId),
        ...(input.status ? [eq(agentToolTrustRules.status, input.status)] : []),
      ),
    )
    .orderBy(desc(agentToolTrustRules.createdAt))
    .limit(200);

  return rows.map(mapAgentToolTrustRule);
}

export async function revokeAgentToolTrustRuleRecord(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  trustRuleId: string;
}) {
  const [row] = await db
    .update(agentToolTrustRules)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(
      and(
        eq(agentToolTrustRules.id, input.trustRuleId),
        // Tenancy and ownership are part of the WHERE rather than checked after
        // the read: without them a known rule id would be revocable — and, by
        // symmetry with any future update path, mutable — across workspaces.
        eq(agentToolTrustRules.teamId, input.teamId),
        eq(agentToolTrustRules.workspaceId, input.workspaceId),
        eq(agentToolTrustRules.userId, input.userId),
      ),
    )
    .returning();

  return row ? mapAgentToolTrustRule(row) : null;
}

export async function createAgentToolTrustRuleRecord(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  domain: string;
  toolName: string;
  connectorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  allowedRiskLevels: ConnectorActionRiskLevel[];
  status?: AgentToolTrustRuleStatus;
  expiresAt?: Date | null;
  createdFromConfirmationId?: string | null;
}) {
  const [row] = await db
    .insert(agentToolTrustRules)
    .values({
      id: randomUUID(),
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      domain: input.domain,
      toolName: input.toolName,
      connectorId: input.connectorId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      allowedRiskLevels: input.allowedRiskLevels,
      status: input.status ?? "active",
      expiresAt: input.expiresAt ?? null,
      createdFromConfirmationId: input.createdFromConfirmationId ?? null,
    })
    .returning();

  if (!row) {
    throw new ConnectorError(
      500,
      "AGENT_TOOL_TRUST_RULE_CREATE_FAILED",
      "Failed to create agent tool trust rule",
      { teamId: input.teamId },
    );
  }

  return mapAgentToolTrustRule(row);
}

export async function touchAgentToolTrustRuleRecord(input: {
  teamId: string;
  workspaceId: string;
  trustRuleId: string;
  lastUsedAt?: Date;
}) {
  const [row] = await db
    .update(agentToolTrustRules)
    .set({
      lastUsedAt: input.lastUsedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentToolTrustRules.id, input.trustRuleId),
        eq(agentToolTrustRules.teamId, input.teamId),
        eq(agentToolTrustRules.workspaceId, input.workspaceId),
      ),
    )
    .returning();

  return row ? mapAgentToolTrustRule(row) : null;
}
