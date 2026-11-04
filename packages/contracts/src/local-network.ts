import { z } from "zod";
import {
  AGENT_TOOL_TRUST_RULE_MAX_TTL_SECONDS,
  agentToolTrustRuleSchema,
} from "./agent-confirmations";

/**
 * Outbound-network policy of one local computer, applied to the commands the
 * agent runs there. `open` is the default and today's behaviour; `ask` and
 * `strict` are per-computer opt-ins. In every mode the private, loopback,
 * cloud-metadata and own-address guard stays authoritative.
 * - `open`   any public host;
 * - `ask`    an unknown host raises an approval while the command keeps running;
 * - `strict` only hosts on the allow list; nothing is ever asked.
 */
export const localNetworkModeSchema = z.enum(["open", "ask", "strict"]);
export type LocalNetworkMode = z.infer<typeof localNetworkModeSchema>;
export const DEFAULT_LOCAL_NETWORK_MODE: LocalNetworkMode = "open";

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

/** A pending approval as the conversation shows it. */
export const localNetworkRequestSchema = z.object({
  id: z.string().min(1),
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
