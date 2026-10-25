import { z } from "zod";
import {
  AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS,
  agentToolTrustRuleSchema,
} from "./agent-confirmations";

/**
 * Outbound-network policy of one local computer, applied to the commands the
 * agent runs there:
 * - `open`   any public host (the private/loopback/metadata guard still holds);
 * - `ask`    an unknown host raises an approval while the command keeps running;
 * - `strict` only hosts on the allow list; nothing is ever asked.
 */
export const localNetworkModeSchema = z.enum(["open", "ask", "strict"]);
export type LocalNetworkMode = z.infer<typeof localNetworkModeSchema>;
export const DEFAULT_LOCAL_NETWORK_MODE: LocalNetworkMode = "ask";

/** How long a user has to answer a network approval before it is denied. */
export const LOCAL_NETWORK_APPROVAL_WINDOW_SECONDS = 120;

/**
 * A standing "allow for this workspace" answer is an ordinary agent tool trust
 * rule with this identity, so the existing rules panel lists and revokes it.
 * `targetId` is the canonical host (all ports).
 */
export const LOCAL_NETWORK_TRUST_DOMAIN = "network";
export const LOCAL_NETWORK_TRUST_TOOL_NAME = "network_access";
export const LOCAL_NETWORK_TRUST_TARGET_TYPE = "host";

/**
 * "Allow for this workspace" is refused for a host no allow-list entry can
 * match (a single-label name or an IP literal); "allow once" still works.
 */
export const LOCAL_NETWORK_HOST_NOT_ALLOWABLE_CODE =
  "NETWORK_HOST_NOT_ALLOWABLE";

export const localNetworkRequestStatusSchema = z.enum([
  "pending",
  "allowed",
  "denied",
  "expired",
]);
export type LocalNetworkRequestStatus = z.infer<
  typeof localNetworkRequestStatusSchema
>;

/**
 * `host`: may the command connect to this host. `request`: may it send this
 * write request to a host whose secret the user bound read-only. A request
 * approval covers that exact method and path for the rest of the command and
 * never becomes a standing rule.
 */
export const localNetworkRequestKindSchema = z.enum(["host", "request"]);
export type LocalNetworkRequestKind = z.infer<
  typeof localNetworkRequestKindSchema
>;
export const LOCAL_NETWORK_REQUEST_ONCE_ONLY_CODE = "NETWORK_REQUEST_ONCE_ONLY";

/** A pending approval as the conversation shows it. */
export const localNetworkRequestSchema = z.object({
  id: z.string().min(1),
  /** Absent from older backends; treat as `host`. */
  kind: localNetworkRequestKindSchema.optional(),
  /** `kind: "request"` only: HTTP method and path (no query string). */
  method: z.string().max(16).nullable().optional(),
  path: z.string().max(200).nullable().optional(),
  /**
   * `kind: "request"` only: a stored secret's value is in the request body, so
   * allowing it sends that secret to the host. Absent from older backends.
   */
  secretInBody: z.boolean().optional(),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  /** First 200 characters of the command that opened the connection. */
  commandPreview: z.string().max(200),
  /** Skill name when a skill declared this domain but is not trusted. */
  suggestedBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type LocalNetworkRequest = z.infer<typeof localNetworkRequestSchema>;

export const listLocalNetworkRequestsResponseSchema = z.object({
  requests: z.array(localNetworkRequestSchema),
});
export type ListLocalNetworkRequestsResponse = z.infer<
  typeof listLocalNetworkRequestsResponseSchema
>;

export const localNetworkDecisionSchema = z.enum([
  "allow_once",
  "allow_always",
  "deny",
]);
export type LocalNetworkDecision = z.infer<typeof localNetworkDecisionSchema>;

/**
 * `trust` is only read for `allow_always`; the rule's subject (workspace,
 * user, host) always comes from the stored request, never from this body.
 */
export const respondLocalNetworkRequestSchema = z
  .object({
    decision: localNetworkDecisionSchema,
    trust: z
      .object({
        ttlSeconds: z
          .number()
          .int()
          .positive()
          .max(AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RespondLocalNetworkRequest = z.infer<
  typeof respondLocalNetworkRequestSchema
>;

export const respondLocalNetworkRequestResponseSchema = z.object({
  request: z.object({
    id: z.string().min(1),
    status: localNetworkRequestStatusSchema,
    scope: z.enum(["once", "always"]).nullable(),
  }),
  /** Present only when `allow_always` actually stored a standing rule. */
  trustRule: agentToolTrustRuleSchema.optional(),
});
export type RespondLocalNetworkRequestResponse = z.infer<
  typeof respondLocalNetworkRequestResponseSchema
>;

export const updateLocalDeviceNetworkModeSchema = z
  .object({ networkMode: localNetworkModeSchema })
  .strict();
export type UpdateLocalDeviceNetworkMode = z.infer<
  typeof updateLocalDeviceNetworkModeSchema
>;

export const updateLocalDeviceNetworkModeResponseSchema = z.object({
  id: z.string().min(1),
  networkMode: localNetworkModeSchema,
});
export type UpdateLocalDeviceNetworkModeResponse = z.infer<
  typeof updateLocalDeviceNetworkModeResponseSchema
>;

/** The `network` block of a `command.execute` payload sent to the device. */
export const localCommandNetworkPolicySchema = z.object({
  mode: localNetworkModeSchema,
  /** Domain patterns (`host`, `*.suffix`) allowed without asking. */
  allow: z.array(z.string().min(1).max(255)).max(500),
  /** Domain pattern -> skill name; display only, never allows anything. */
  suggested: z.record(z.string().min(1).max(255), z.string().max(128)),
});
export type LocalCommandNetworkPolicy = z.infer<
  typeof localCommandNetworkPolicySchema
>;
