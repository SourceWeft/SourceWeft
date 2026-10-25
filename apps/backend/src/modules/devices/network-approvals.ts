import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  localDevices,
  localNetworkRequests,
  localToolInvocations,
  threads,
} from "@sourceweft/db";
import {
  LOCAL_NETWORK_APPROVAL_WINDOW_SECONDS,
  LOCAL_NETWORK_TRUST_DOMAIN,
  LOCAL_NETWORK_TRUST_TARGET_TYPE,
  LOCAL_NETWORK_TRUST_TOOL_NAME,
  type AgentToolTrustRule,
  type ListLocalNetworkRequestsResponse,
  type LocalCommandNetworkPolicy,
  type LocalNetworkDecision,
  type LocalNetworkMode,
  type RespondLocalNetworkRequestResponse,
} from "@sourceweft/contracts";
import { ApiError } from "../../api/response/api-response";
import { logger } from "../../shared/logger";
import { requireConnectorWorkspace } from "../connectors/permissions";
import { listAgentToolTrustRuleRecords } from "../connectors/repository/trust-rule";
import {
  findAgentToolTrustRuleForScope,
  recordAgentToolTrustRule,
  touchAgentToolTrustRuleUse,
  type AgentToolTrustScope,
} from "../agent-confirmations/trust-rules";
import type { AgentToolTrustRuleRecord } from "../connectors/types";
import { requireDeviceAccess, type LocalExecutionCaller } from "./access";
import {
  canonicalNetworkHost,
  matchesAnyNetworkPattern,
} from "./network-policy";
import {
  MAX_NETWORK_POLICY_ENTRIES,
  resolveSkillNetworkDomains,
  type NetworkSkillInput,
} from "./network-skill-domains";

/** What the backend sends the device for one `network.ask`. */
export type NetworkDecisionFrame = {
  type: "network.decision";
  askId: string;
  allow: boolean;
  reason?: string;
};

export type NetworkAskMessage = {
  /** The invocation id of the `command.execute` call. */
  id: string;
  askId: string;
  host: string;
  port: number;
};

type NetworkRequestRow = typeof localNetworkRequests.$inferSelect;

const ACTIVE_COMMAND_STATUSES = ["accepted", "running"];
const NETWORK_RULE_RISK = "medium" as const;
const DELIVERY_BATCH = 50;

export const NETWORK_REASONS = {
  noCommand: "no active command for this approval",
  strict: "host is not on the allow list (strict network mode)",
  timedOut: "approval timed out",
  commandFinished: "command finished",
  denied: "denied by user",
  unavailable: "network approval is unavailable",
  invalidHost: "invalid host",
} as const;

export function networkTrustScope(host: string): AgentToolTrustScope {
  return {
    domain: LOCAL_NETWORK_TRUST_DOMAIN,
    toolName: LOCAL_NETWORK_TRUST_TOOL_NAME,
    connectorId: null,
    targetType: LOCAL_NETWORK_TRUST_TARGET_TYPE,
    targetId: host,
    riskLevel: NETWORK_RULE_RISK,
  };
}

export function denyFrame(askId: string, reason: string): NetworkDecisionFrame {
  return { type: "network.decision", askId, allow: false, reason };
}

/** The frame for a settled row. Pure so delivery and idempotent replies agree. */
export function decisionFrameForRow(
  row: Pick<NetworkRequestRow, "askId" | "status" | "reason">,
): NetworkDecisionFrame {
  if (row.status === "allowed")
    return { type: "network.decision", askId: row.askId, allow: true };
  return denyFrame(
    row.askId,
    row.reason ??
      (row.status === "expired"
        ? NETWORK_REASONS.timedOut
        : NETWORK_REASONS.denied),
  );
}

/** Active, unexpired `network_access` rules as allow-list patterns (exact hosts). */
export function allowPatternsFromRules(
  rules: readonly AgentToolTrustRuleRecord[],
  now: Date,
): string[] {
  const patterns: string[] = [];
  for (const rule of rules) {
    if (
      rule.status !== "active" ||
      rule.domain !== LOCAL_NETWORK_TRUST_DOMAIN ||
      rule.toolName !== LOCAL_NETWORK_TRUST_TOOL_NAME ||
      rule.targetType !== LOCAL_NETWORK_TRUST_TARGET_TYPE ||
      rule.connectorId !== null ||
      !rule.allowedRiskLevels.includes(NETWORK_RULE_RISK) ||
      !rule.targetId
    )
      continue;
    if (rule.expiresAt) {
      const expiresAt = new Date(rule.expiresAt).getTime();
      // An unparseable expiry fails closed.
      if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) continue;
    }
    const host = canonicalNetworkHost(rule.targetId);
    if (host && host === rule.targetId) patterns.push(host);
  }
  return patterns;
}

/** The first live rule whose host covers this connection. */
export function matchingNetworkRule(
  rules: readonly AgentToolTrustRuleRecord[],
  host: string,
  port: number,
  now: Date,
): AgentToolTrustRuleRecord | undefined {
  return rules.find((rule) =>
    matchesAnyNetworkPattern(host, port, allowPatternsFromRules([rule], now)),
  );
}

export function buildCommandNetworkPolicy(input: {
  mode: LocalNetworkMode;
  rules: readonly AgentToolTrustRuleRecord[];
  skills: readonly NetworkSkillInput[];
  now: Date;
}): LocalCommandNetworkPolicy {
  // Open lets every public host through and strict never asks, but strict is
  // still an allow-list mode, so only open needs no list.
  if (input.mode === "open") return { mode: "open", allow: [], suggested: {} };
  const skills = resolveSkillNetworkDomains(input.skills);
  const allow = [
    ...new Set([
      ...allowPatternsFromRules(input.rules, input.now),
      ...skills.trusted,
    ]),
  ].slice(0, MAX_NETWORK_POLICY_ENTRIES);
  return { mode: input.mode, allow, suggested: skills.suggested };
}

/**
 * The `network` block of a `command.execute` payload. Resolved per command so
 * a rule the user just created applies to the next command, and a revoked one
 * stops applying.
 */
export async function resolveCommandNetworkPolicy(input: {
  deviceId: string;
  tenant: { teamId: string; workspaceId: string; userId: string };
  skills?: readonly NetworkSkillInput[];
  now?: Date;
}): Promise<LocalCommandNetworkPolicy> {
  const now = input.now ?? new Date();
  const [device] = await db
    .select({ networkMode: localDevices.networkMode })
    .from(localDevices)
    .where(
      and(
        eq(localDevices.id, input.deviceId),
        eq(localDevices.userId, input.tenant.userId),
        isNull(localDevices.revokedAt),
      ),
    );
  if (!device)
    throw new ApiError(
      404,
      "LOCAL_DEVICE_NOT_FOUND",
      "No computer was found for this account.",
    );
  const mode = device.networkMode as LocalNetworkMode;
  const rules =
    mode === "open"
      ? []
      : await listAgentToolTrustRuleRecords({
          ...input.tenant,
          status: "active",
          domain: LOCAL_NETWORK_TRUST_DOMAIN,
          toolName: LOCAL_NETWORK_TRUST_TOOL_NAME,
        });
  return buildCommandNetworkPolicy({
    mode,
    rules,
    skills: input.skills ?? [],
    now,
  });
}

/**
 * Handles a device's `network.ask`. Returns the decision to send back now, or
 * null when the question is parked for the user (a pending row). Nothing is
 * kept in memory: the row is what every instance, the web routes and the
 * delivery loop agree on, and `(device, askId)` makes a re-sent ask harmless.
 *
 * A foreign, finished or malformed ask is answered with a deny and not stored,
 * so a device can never create state about another device's commands.
 */
export async function handleNetworkAsk(
  device: { id: string; userId: string },
  ask: NetworkAskMessage,
  now: Date = new Date(),
): Promise<NetworkDecisionFrame | null> {
  const host = canonicalNetworkHost(ask.host);
  if (!host) return denyFrame(ask.askId, NETWORK_REASONS.invalidHost);

  const [existing] = await db
    .select()
    .from(localNetworkRequests)
    .where(
      and(
        eq(localNetworkRequests.deviceId, device.id),
        eq(localNetworkRequests.askId, ask.askId),
      ),
    );
  if (existing) return replyForExisting(existing, ask, host);

  const [invocation] = await db
    .select()
    .from(localToolInvocations)
    .where(
      and(
        eq(localToolInvocations.id, ask.id),
        eq(localToolInvocations.deviceId, device.id),
        eq(localToolInvocations.userId, device.userId),
      ),
    );
  if (
    !invocation ||
    invocation.action !== "command.execute" ||
    !invocation.threadId ||
    !ACTIVE_COMMAND_STATUSES.includes(invocation.status)
  )
    return denyFrame(ask.askId, NETWORK_REASONS.noCommand);

  const [live] = await db
    .select({ networkMode: localDevices.networkMode })
    .from(localDevices)
    .where(and(eq(localDevices.id, device.id), isNull(localDevices.revokedAt)));
  if (!live) return denyFrame(ask.askId, NETWORK_REASONS.noCommand);
  // The mode may have changed since the command started.
  if (live.networkMode === "open")
    return { type: "network.decision", askId: ask.askId, allow: true };
  if (live.networkMode === "strict")
    return denyFrame(ask.askId, NETWORK_REASONS.strict);

  const [thread] = await db
    .select({
      teamId: threads.teamId,
      workspaceId: threads.workspaceId,
      createdBy: threads.createdBy,
    })
    .from(threads)
    .where(eq(threads.id, invocation.threadId));
  if (!thread || thread.createdBy !== device.userId)
    return denyFrame(ask.askId, NETWORK_REASONS.noCommand);

  const tenant = {
    teamId: thread.teamId,
    workspaceId: thread.workspaceId,
    userId: device.userId,
  };
  const rules = await listAgentToolTrustRuleRecords({
    ...tenant,
    status: "active",
    domain: LOCAL_NETWORK_TRUST_DOMAIN,
    toolName: LOCAL_NETWORK_TRUST_TOOL_NAME,
  });
  const rule = matchingNetworkRule(rules, host, ask.port, now);
  if (rule) {
    await touchAgentToolTrustRuleUse({
      trustRuleId: rule.id,
      tenant,
      now,
    }).catch((error: unknown) =>
      logger.warn("Network trust rule use was not recorded", {
        error: String(error),
      }),
    );
    return { type: "network.decision", askId: ask.askId, allow: true };
  }

  const suggestedBy = suggestedSkillFor(invocation.payload, host, ask.port);
  const [created] = await db
    .insert(localNetworkRequests)
    .values({
      id: randomUUID(),
      invocationId: invocation.id,
      deviceId: device.id,
      userId: device.userId,
      teamId: thread.teamId,
      workspaceId: thread.workspaceId,
      threadId: invocation.threadId,
      askId: ask.askId,
      host,
      port: ask.port,
      suggestedBy,
      createdAt: now,
      expiresAt: new Date(
        now.getTime() + LOCAL_NETWORK_APPROVAL_WINDOW_SECONDS * 1000,
      ),
    })
    .onConflictDoNothing()
    .returning({ id: localNetworkRequests.id });
  if (!created) {
    // Lost a race with a re-sent ask: answer from whichever row won.
    const [winner] = await db
      .select()
      .from(localNetworkRequests)
      .where(
        and(
          eq(localNetworkRequests.deviceId, device.id),
          eq(localNetworkRequests.askId, ask.askId),
        ),
      );
    return winner ? replyForExisting(winner, ask, host) : null;
  }
  return null;
}

function replyForExisting(
  row: NetworkRequestRow,
  ask: NetworkAskMessage,
  host: string,
): NetworkDecisionFrame | null {
  // The same askId for a different command/target is not a retry.
  if (row.invocationId !== ask.id || row.port !== ask.port || row.host !== host)
    return denyFrame(ask.askId, NETWORK_REASONS.noCommand);
  return row.status === "pending" ? null : decisionFrameForRow(row);
}

function suggestedSkillFor(
  payload: Record<string, unknown>,
  host: string,
  port: number,
): string | null {
  const network = payload.network;
  if (!network || typeof network !== "object") return null;
  const suggested = (network as { suggested?: unknown }).suggested;
  if (!suggested || typeof suggested !== "object") return null;
  for (const [pattern, skill] of Object.entries(suggested)) {
    if (
      typeof skill === "string" &&
      matchesAnyNetworkPattern(host, port, [pattern])
    )
      return skill.slice(0, 128);
  }
  return null;
}

/**
 * One tick of the gateway loop for a connected device: settle what can no
 * longer be answered, then hand every settled-but-undelivered decision to the
 * device. `send` returns false when the socket is gone, in which case nothing
 * is marked delivered and the next connection gets them.
 */
export async function deliverNetworkDecisions(
  deviceId: string,
  send: (frame: NetworkDecisionFrame) => boolean,
  options: { sweep?: boolean; now?: Date } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  if (options.sweep !== false) {
    const stamp = now.toISOString();
    // Qualified by table name on purpose: the NOT EXISTS subquery would
    // otherwise make `id`/`status` ambiguous inside the UPDATE.
    await db
      .update(localNetworkRequests)
      .set({
        status: "expired",
        resolvedAt: now,
        reason: sql`case when local_network_requests.expires_at <= ${stamp}::timestamptz then ${NETWORK_REASONS.timedOut}::text else ${NETWORK_REASONS.commandFinished}::text end`,
      })
      .where(
        and(
          eq(localNetworkRequests.deviceId, deviceId),
          isNull(localNetworkRequests.deliveredAt),
          eq(localNetworkRequests.status, "pending"),
          sql`(local_network_requests.expires_at <= ${stamp}::timestamptz or not exists (select 1 from local_tool_invocations lti where lti.id = local_network_requests.invocation_id and lti.status in ('accepted', 'running')))`,
        ),
      );
  }
  const rows = await db
    .select()
    .from(localNetworkRequests)
    .where(
      and(
        eq(localNetworkRequests.deviceId, deviceId),
        isNull(localNetworkRequests.deliveredAt),
        inArray(localNetworkRequests.status, ["allowed", "denied", "expired"]),
      ),
    )
    .orderBy(asc(localNetworkRequests.resolvedAt))
    .limit(DELIVERY_BATCH);
  const delivered: string[] = [];
  for (const row of rows) {
    if (!send(decisionFrameForRow(row))) break;
    delivered.push(row.id);
  }
  if (delivered.length)
    await db
      .update(localNetworkRequests)
      .set({ deliveredAt: now })
      .where(
        and(
          inArray(localNetworkRequests.id, delivered),
          isNull(localNetworkRequests.deliveredAt),
        ),
      );
  return delivered.length;
}

export async function listPendingNetworkRequests(input: {
  userId: string;
  workspaceId: string;
  threadId: string;
  now?: Date;
}): Promise<ListLocalNetworkRequestsResponse> {
  const now = input.now ?? new Date();
  const rows = await db
    .select({
      request: localNetworkRequests,
      payload: localToolInvocations.payload,
    })
    .from(localNetworkRequests)
    .innerJoin(
      localToolInvocations,
      eq(localToolInvocations.id, localNetworkRequests.invocationId),
    )
    .innerJoin(localDevices, eq(localDevices.id, localNetworkRequests.deviceId))
    .where(
      and(
        eq(localNetworkRequests.threadId, input.threadId),
        eq(localNetworkRequests.workspaceId, input.workspaceId),
        eq(localNetworkRequests.userId, input.userId),
        eq(localNetworkRequests.status, "pending"),
        gt(localNetworkRequests.expiresAt, now),
        isNull(localDevices.revokedAt),
      ),
    )
    .orderBy(asc(localNetworkRequests.createdAt))
    .limit(50);
  return {
    requests: rows.map(({ request, payload }) => ({
      id: request.id,
      host: request.host,
      port: request.port,
      commandPreview:
        typeof payload.command === "string"
          ? payload.command.slice(0, 200)
          : "",
      suggestedBy: request.suggestedBy,
      createdAt: request.createdAt.toISOString(),
      expiresAt: request.expiresAt.toISOString(),
    })),
  };
}

function decisionOfRow(
  row: Pick<NetworkRequestRow, "status" | "scope">,
): LocalNetworkDecision | null {
  if (row.status === "denied") return "deny";
  if (row.status === "allowed")
    return row.scope === "always" ? "allow_always" : "allow_once";
  return null;
}

function responseFor(
  row: NetworkRequestRow,
  trustRule?: AgentToolTrustRule,
): RespondLocalNetworkRequestResponse {
  return {
    request: {
      id: row.id,
      status:
        row.status as RespondLocalNetworkRequestResponse["request"]["status"],
      scope: row.scope as "once" | "always" | null,
    },
    ...(trustRule ? { trustRule } : {}),
  };
}

/**
 * The user's answer. Only the owner of the conversation the command runs in
 * can answer (a stranger, another workspace and a revoked computer all look
 * like "not found"). The answer is a conditional update, so two clicks or two
 * instances settle the row exactly once; repeating the same answer is a
 * no-op, a different one is a conflict.
 */
export async function respondToNetworkRequest(input: {
  userId: string;
  workspaceId: string;
  requestId: string;
  decision: LocalNetworkDecision;
  ttlSeconds?: number;
  now?: Date;
}): Promise<RespondLocalNetworkRequestResponse> {
  const now = input.now ?? new Date();
  const [found] = await db
    .select({ request: localNetworkRequests })
    .from(localNetworkRequests)
    .innerJoin(localDevices, eq(localDevices.id, localNetworkRequests.deviceId))
    .where(
      and(
        eq(localNetworkRequests.id, input.requestId),
        eq(localNetworkRequests.workspaceId, input.workspaceId),
        eq(localNetworkRequests.userId, input.userId),
        isNull(localDevices.revokedAt),
      ),
    );
  if (!found)
    throw new ApiError(
      404,
      "NETWORK_REQUEST_NOT_FOUND",
      "This network request was not found.",
    );
  const request = found.request;

  // Standing permission is a workspace-level grant: check it before the row
  // is settled so a refused "always" can still be answered "once".
  if (input.decision === "allow_always")
    await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.action.approve",
    });

  const settled =
    input.decision === "deny"
      ? {
          status: "denied" as const,
          scope: null,
          reason: NETWORK_REASONS.denied,
        }
      : {
          status: "allowed" as const,
          scope: input.decision === "allow_always" ? "always" : "once",
          reason: null,
        };
  const [updated] = await db
    .update(localNetworkRequests)
    .set({ ...settled, resolvedAt: now })
    .where(
      and(
        eq(localNetworkRequests.id, request.id),
        eq(localNetworkRequests.status, "pending"),
        gt(localNetworkRequests.expiresAt, now),
      ),
    )
    .returning();
  if (!updated) {
    const [current] = await db
      .select()
      .from(localNetworkRequests)
      .where(eq(localNetworkRequests.id, request.id));
    if (current && decisionOfRow(current) === input.decision)
      return responseFor(current);
    throw new ApiError(
      409,
      current?.status === "pending" || current?.status === "expired"
        ? "NETWORK_REQUEST_EXPIRED"
        : "NETWORK_REQUEST_RESOLVED",
      current?.status === "pending" || current?.status === "expired"
        ? "This network request has expired."
        : "This network request was already answered differently.",
    );
  }

  logger.info("Local network request answered", {
    requestId: updated.id,
    deviceId: updated.deviceId,
    userId: input.userId,
    host: updated.host,
    port: updated.port,
    decision: input.decision,
  });
  if (input.decision !== "allow_always") return responseFor(updated);

  const tenant = {
    teamId: updated.teamId,
    workspaceId: updated.workspaceId,
    userId: updated.userId,
  };
  const scope = networkTrustScope(updated.host);
  const existing = await findAgentToolTrustRuleForScope({
    scope,
    tenant,
    now,
  });
  const rule =
    existing ??
    (await recordAgentToolTrustRule({
      scope,
      tenant,
      confirmationId: updated.id,
      ...(typeof input.ttlSeconds === "number"
        ? { ttlSeconds: input.ttlSeconds }
        : {}),
      now,
    }));
  return responseFor(updated, rule);
}

/**
 * Per-computer network mode. Like the remote-access switch it can only be
 * changed from that computer: loosening the sandbox is not something a
 * browser session should be able to do.
 */
export async function setDeviceNetworkMode(input: {
  userId: string;
  deviceId: string;
  caller: LocalExecutionCaller;
  networkMode: LocalNetworkMode;
}) {
  const access = await requireDeviceAccess(
    input.userId,
    input.deviceId,
    input.caller,
  );
  if (!access.native)
    throw new ApiError(
      403,
      "LOCAL_SETTINGS_ONLY",
      "This setting can only be changed on that computer.",
    );
  const [device] = await db
    .update(localDevices)
    .set({ networkMode: input.networkMode })
    .where(
      and(
        eq(localDevices.id, input.deviceId),
        eq(localDevices.userId, input.userId),
        isNull(localDevices.revokedAt),
      ),
    )
    .returning({ id: localDevices.id, networkMode: localDevices.networkMode });
  if (!device)
    throw new ApiError(
      404,
      "LOCAL_DEVICE_NOT_FOUND",
      "No computer was found for this account.",
    );
  return { id: device.id, networkMode: device.networkMode as LocalNetworkMode };
}
