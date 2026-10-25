import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  agentToolTrustRules,
  db,
  localDevices,
  localNetworkRequests,
  localToolInvocations,
  threads,
} from "@sourceweft/db";
import {
  LOCAL_NETWORK_APPROVAL_WINDOW_SECONDS,
  LOCAL_NETWORK_HOST_NOT_ALLOWABLE_CODE,
  LOCAL_NETWORK_REQUEST_ONCE_ONLY_CODE,
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
  touchAgentToolTrustRuleUse,
  type AgentToolTrustScope,
} from "../agent-confirmations/trust-rules";
import { resolveAgentToolTrustRuleExpiry } from "../connectors/agent-tool-trust";
import { mapAgentToolTrustRule } from "../connectors/mappers";
import type { AgentToolTrustRuleRecord } from "../connectors/types";
import { requireDeviceAccess, type LocalExecutionCaller } from "./access";
import {
  canonicalNetworkHost,
  isAllowableRuleHost,
  matchesAnyNetworkPattern,
  sidecarAllowEntry,
} from "./network-policy";
import {
  resolveSkillNetworkDomains,
  type NetworkSkillInput,
} from "./network-skill-domains";

/** What the backend sends the device for one `network.ask`. */
export type NetworkDecisionFrame = {
  type: "network.decision";
  askId: string;
  allow: boolean;
  reason?: string;
  /**
   * Echoed for answers about a write request, so a device can tell them from
   * answers about a host and refuses one that lacks it (an older backend).
   */
  kind?: "request";
};

export type NetworkAskMessage = {
  /** The invocation id of the `command.execute` call. */
  id: string;
  askId: string;
  host: string;
  port: number;
  /** Absent or `host`: a connection. `request`: one write request to a secret-bound host. */
  kind?: string | undefined;
  method?: string | undefined;
  path?: string | undefined;
  /** `request` only: a stored secret's value is in the request body. */
  secretInBody?: boolean | undefined;
};

type AskShape =
  | { kind: "host"; method: null; path: null; secretInBody: false }
  | { kind: "request"; method: string; path: string; secretInBody: boolean };

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
  invalidAsk: "invalid network request",
  invalidRequest: "invalid request",
  tooMany: "too many network requests",
} as const;

/**
 * Entries sent in a command's `allow` list. The device merges up to 200 vault
 * hosts into it and the sandbox refuses a list over 500, so this leaves room.
 */
export const MAX_NETWORK_ALLOW_ENTRIES = 300;

/** Bounds on what one command and one computer may leave waiting. */
export const MAX_NETWORK_REQUESTS_PER_COMMAND = 20;
export const MAX_PENDING_NETWORK_REQUESTS_PER_DEVICE = 100;
/** Settled rows are audit-only after the card is gone; keep a week of them. */
export const NETWORK_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const NETWORK_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
let lastPrunedAt = 0;

/**
 * When a pending request lapses: the approval window, or the command's own
 * deadline if that comes first. A missing or unparseable deadline falls back to
 * the window alone.
 */
export function approvalExpiry(
  now: Date,
  deadline: Date | null | undefined,
): Date {
  const window = now.getTime() + LOCAL_NETWORK_APPROVAL_WINDOW_SECONDS * 1000;
  const limit = deadline ? deadline.getTime() : Number.NaN;
  return new Date(Number.isFinite(limit) ? Math.min(window, limit) : window);
}

/**
 * What an ask is about. A request ask needs an upper-case method and an
 * origin-form path (no query, no control characters, at most 200 characters);
 * a host ask carries neither. Anything else is unusable, not a protocol error.
 */
export function readAskShape(ask: {
  kind?: string | undefined;
  method?: string | undefined;
  path?: string | undefined;
  secretInBody?: boolean | undefined;
}): AskShape | null {
  if (ask.kind === undefined || ask.kind === "host")
    return ask.method === undefined &&
      ask.path === undefined &&
      ask.secretInBody !== true
      ? { kind: "host", method: null, path: null, secretInBody: false }
      : null;
  if (ask.kind !== "request") return null;
  if (typeof ask.method !== "string" || !/^[A-Z]{1,16}$/.test(ask.method))
    return null;
  if (
    typeof ask.path !== "string" ||
    !ask.path.startsWith("/") ||
    ask.path.length > 200 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(ask.path)
  )
    return null;
  return {
    kind: "request",
    method: ask.method,
    path: ask.path,
    secretInBody: ask.secretInBody === true,
  };
}

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

/** Marks the answer to a write-request ask; host answers stay unmarked. */
export function withAskKind<T extends NetworkDecisionFrame>(
  frame: T,
  kind: string | undefined,
): T {
  return kind === "request" ? { ...frame, kind: "request" } : frame;
}

/** The frame for a settled row. Pure so delivery and idempotent replies agree. */
export function decisionFrameForRow(
  row: Pick<NetworkRequestRow, "askId" | "status" | "reason"> &
    Partial<Pick<NetworkRequestRow, "kind">>,
): NetworkDecisionFrame {
  const frame: NetworkDecisionFrame =
    row.status === "allowed"
      ? { type: "network.decision", askId: row.askId, allow: true }
      : denyFrame(
          row.askId,
          row.reason ??
            (row.status === "expired"
              ? NETWORK_REASONS.timedOut
              : NETWORK_REASONS.denied),
        );
  return withAskKind(frame, row.kind);
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
  // Only entries the device's runtime will actually keep, within the room the
  // desktop leaves for the vault hosts it merges in. Skill domains come first;
  // rules follow newest first, so the oldest are the ones dropped past the cap.
  const newestFirst = [...input.rules].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
  const allow = [
    ...new Set(
      [...skills.trusted, ...allowPatternsFromRules(newestFirst, input.now)]
        .map(sidecarAllowEntry)
        .filter((entry): entry is string => entry !== null),
    ),
  ].slice(0, MAX_NETWORK_ALLOW_ENTRIES);
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
  // Every answer to a write-request ask, denials and replays included, echoes
  // the kind the device asked with.
  const frame = await answerNetworkAsk(device, ask, now);
  return frame ? withAskKind(frame, ask.kind) : null;
}

async function answerNetworkAsk(
  device: { id: string; userId: string },
  ask: NetworkAskMessage,
  now: Date,
): Promise<NetworkDecisionFrame | null> {
  // The host and port are whatever the sandboxed program tried to connect to;
  // anything unusable is a deny, never a protocol error.
  if (ask.askId.length === 0 || ask.askId.length > 128)
    return denyFrame(ask.askId, NETWORK_REASONS.invalidAsk);
  const host = canonicalNetworkHost(ask.host);
  if (!host) return denyFrame(ask.askId, NETWORK_REASONS.invalidHost);
  if (!Number.isInteger(ask.port) || ask.port < 1 || ask.port > 65535)
    return denyFrame(ask.askId, NETWORK_REASONS.invalidAsk);
  const shape = readAskShape(ask);
  if (!shape) return denyFrame(ask.askId, NETWORK_REASONS.invalidRequest);

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

  // The live mode comes before anything stored, so a switch to strict also
  // governs a re-sent ask whose earlier answer was an allow.
  const [live] = await db
    .select({ networkMode: localDevices.networkMode })
    .from(localDevices)
    .where(and(eq(localDevices.id, device.id), isNull(localDevices.revokedAt)));
  if (!live) return denyFrame(ask.askId, NETWORK_REASONS.noCommand);
  // The mode is about which HOSTS a command may reach. A write request to a
  // secret-bound host is a different question, and always the user's to
  // answer: neither open nor strict nor a rule answers it.
  if (shape.kind === "host") {
    if (live.networkMode === "open")
      return { type: "network.decision", askId: ask.askId, allow: true };
    if (live.networkMode === "strict")
      return denyFrame(ask.askId, NETWORK_REASONS.strict);
  }

  const [existing] = await db
    .select()
    .from(localNetworkRequests)
    .where(
      and(
        eq(localNetworkRequests.deviceId, device.id),
        eq(localNetworkRequests.askId, ask.askId),
      ),
    );
  if (existing) return replyForExisting(existing, ask, host, shape);

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
  // Trust rules are about hosts; a request ask never reads or touches them.
  const rules =
    shape.kind === "host"
      ? await listAgentToolTrustRuleRecords({
          ...tenant,
          status: "active",
          domain: LOCAL_NETWORK_TRUST_DOMAIN,
          toolName: LOCAL_NETWORK_TRUST_TOOL_NAME,
        })
      : [];
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

  const [perCommand] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(localNetworkRequests)
    .where(eq(localNetworkRequests.invocationId, invocation.id));
  const [perDevice] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(localNetworkRequests)
    .where(
      and(
        eq(localNetworkRequests.deviceId, device.id),
        eq(localNetworkRequests.status, "pending"),
      ),
    );
  if (
    (perCommand?.count ?? 0) >= MAX_NETWORK_REQUESTS_PER_COMMAND ||
    (perDevice?.count ?? 0) >= MAX_PENDING_NETWORK_REQUESTS_PER_DEVICE
  )
    return denyFrame(ask.askId, NETWORK_REASONS.tooMany);

  // The card's countdown never outlives the command it belongs to.
  const expiresAt = approvalExpiry(now, invocation.deadline);
  if (expiresAt.getTime() <= now.getTime())
    return denyFrame(ask.askId, NETWORK_REASONS.timedOut);

  const suggestedBy =
    shape.kind === "host"
      ? suggestedSkillFor(invocation.payload, host, ask.port)
      : null;
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
      kind: shape.kind,
      host,
      port: ask.port,
      method: shape.method,
      path: shape.path,
      secretInBody: shape.secretInBody,
      suggestedBy,
      createdAt: now,
      expiresAt,
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
    return winner ? replyForExisting(winner, ask, host, shape) : null;
  }
  return null;
}

function replyForExisting(
  row: NetworkRequestRow,
  ask: NetworkAskMessage,
  host: string,
  shape: AskShape,
): NetworkDecisionFrame | null {
  // The same askId for a different command/target is not a retry.
  if (
    row.invocationId !== ask.id ||
    row.port !== ask.port ||
    row.host !== host ||
    row.kind !== shape.kind ||
    row.method !== shape.method ||
    row.path !== shape.path ||
    row.secretInBody !== shape.secretInBody
  )
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

function shouldPruneNow(now: Date): boolean {
  if (now.getTime() - lastPrunedAt < NETWORK_PRUNE_INTERVAL_MS) return false;
  lastPrunedAt = now.getTime();
  return true;
}

/** Test seam: forget when this process last pruned. */
export function resetNetworkPruneClock() {
  lastPrunedAt = 0;
}

/** Deletes answered or expired requests past retention; pending ones are never touched. */
export async function pruneSettledNetworkRequests(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - NETWORK_REQUEST_RETENTION_MS);
  const deleted = await db
    .delete(localNetworkRequests)
    .where(
      and(
        inArray(localNetworkRequests.status, ["allowed", "denied", "expired"]),
        lt(localNetworkRequests.resolvedAt, cutoff),
      ),
    )
    .returning({ id: localNetworkRequests.id });
  return deleted.length;
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
  options: { sweep?: boolean; now?: Date; prune?: boolean } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  if (options.sweep !== false) {
    // Cheap housekeeping rides the sweep, at most every few minutes per process.
    if (options.prune ?? shouldPruneNow(now))
      await pruneSettledNetworkRequests(now).catch((error: unknown) =>
        logger.warn("Network request pruning failed", { error: String(error) }),
      );
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
        // A card never outlives the command it belongs to.
        inArray(localToolInvocations.status, ACTIVE_COMMAND_STATUSES),
        isNull(localDevices.revokedAt),
      ),
    )
    .orderBy(asc(localNetworkRequests.createdAt))
    .limit(50);
  return {
    requests: rows.map(({ request, payload }) => ({
      id: request.id,
      kind: request.kind as "host" | "request",
      method: request.method,
      path: request.path,
      secretInBody: request.secretInBody,
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

  // An approved write request covers this exact method and path for the rest
  // of the command; it never becomes a standing rule, so there is nothing a
  // rule could safely match (and no rule is ever read or written).
  if (request.kind === "request" && input.decision === "allow_always")
    throw new ApiError(
      400,
      LOCAL_NETWORK_REQUEST_ONCE_ONLY_CODE,
      "A write request cannot be allowed permanently: allow it for this command or deny it.",
    );

  // A standing rule for a host the device can never match would be a promise
  // the sandbox does not keep. Refused up front: the request stays answerable.
  if (input.decision === "allow_always" && !isAllowableRuleHost(request.host))
    throw new ApiError(
      400,
      LOCAL_NETWORK_HOST_NOT_ALLOWABLE_CODE,
      "This host cannot be allowed permanently. Allow it once instead.",
    );

  // Answering needs the right to run commands here at all (a viewer cannot);
  // a standing grant is a workspace-level approval. Checked before the row is
  // settled so a refused "always" can still be answered "once". Denying is
  // always allowed.
  if (input.decision !== "deny")
    await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission:
        input.decision === "allow_always"
          ? "connector.action.approve"
          : "connector.action.propose",
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
  // One transaction: the row only becomes "always" together with its rule, so
  // a failure while storing the rule leaves the request pending and answerable.
  const outcome = await db.transaction(async (tx) => {
    if (input.decision === "allow_always")
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`network-rule:${request.teamId}:${request.workspaceId}:${request.userId}:${request.host}`}, 0))`,
      );
    const [updated] = await tx
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
    if (!updated) return null;
    return {
      updated,
      rule:
        input.decision === "allow_always"
          ? await upsertNetworkTrustRule(tx, {
              row: updated,
              ...(typeof input.ttlSeconds === "number"
                ? { ttlSeconds: input.ttlSeconds }
                : {}),
              now,
            })
          : undefined,
    };
  });
  if (!outcome) {
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
    requestId: outcome.updated.id,
    deviceId: outcome.updated.deviceId,
    userId: input.userId,
    host: outcome.updated.host,
    port: outcome.updated.port,
    decision: input.decision,
    trustRuleId: outcome.rule?.id,
  });
  return responseFor(outcome.updated, outcome.rule);
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * One standing rule per (team, workspace, user, host): a new "always" reuses
 * the active rule and only ever lengthens its expiry. Callers hold an advisory
 * lock on that identity, which stands in for the unique index the shared
 * trust-rule table does not have.
 */
async function upsertNetworkTrustRule(
  tx: Transaction,
  input: { row: NetworkRequestRow; ttlSeconds?: number; now: Date },
): Promise<AgentToolTrustRule> {
  const scope = networkTrustScope(input.row.host);
  const expiresAt = resolveAgentToolTrustRuleExpiry({
    ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
    now: input.now,
  });
  const [existing] = await tx
    .select()
    .from(agentToolTrustRules)
    .where(
      and(
        eq(agentToolTrustRules.teamId, input.row.teamId),
        eq(agentToolTrustRules.workspaceId, input.row.workspaceId),
        eq(agentToolTrustRules.userId, input.row.userId),
        eq(agentToolTrustRules.domain, scope.domain),
        eq(agentToolTrustRules.toolName, scope.toolName),
        isNull(agentToolTrustRules.connectorId),
        eq(agentToolTrustRules.targetType, scope.targetType!),
        eq(agentToolTrustRules.targetId, scope.targetId!),
        eq(agentToolTrustRules.status, "active"),
      ),
    )
    .orderBy(desc(agentToolTrustRules.createdAt))
    .limit(1);
  if (existing) {
    const levels = existing.allowedRiskLevels.includes(scope.riskLevel)
      ? existing.allowedRiskLevels
      : [...existing.allowedRiskLevels, scope.riskLevel];
    const [extended] = await tx
      .update(agentToolTrustRules)
      .set({
        allowedRiskLevels: levels,
        // Never shortens a longer grant, never turns a limited one permanent.
        expiresAt:
          existing.expiresAt === null || existing.expiresAt > expiresAt
            ? existing.expiresAt
            : expiresAt,
        updatedAt: input.now,
      })
      .where(eq(agentToolTrustRules.id, existing.id))
      .returning();
    return mapAgentToolTrustRule(extended!);
  }
  const [created] = await tx
    .insert(agentToolTrustRules)
    .values({
      id: randomUUID(),
      teamId: input.row.teamId,
      workspaceId: input.row.workspaceId,
      userId: input.row.userId,
      domain: scope.domain,
      toolName: scope.toolName,
      connectorId: null,
      targetType: scope.targetType,
      targetId: scope.targetId,
      allowedRiskLevels: [scope.riskLevel],
      status: "active",
      expiresAt,
      createdFromConfirmationId: input.row.id,
    })
    .returning();
  logger.info("Network trust rule created", {
    workspaceId: input.row.workspaceId,
    userId: input.row.userId,
    trustRuleId: created!.id,
    host: input.row.host,
    expiresAt,
  });
  return mapAgentToolTrustRule(created!);
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
