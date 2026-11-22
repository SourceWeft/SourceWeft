import { z } from "zod";

/**
 * Workspace assistant: a standing, per-workspace router that turns member
 * messages and worker reports into tickets, and the tickets themselves, each
 * worked by its own worker thread.
 *
 * One `assistants` row per workspace holds the router thread and its status.
 * Each `assistant_tickets` row is one piece of work, with its own worker
 * thread. `assistant_feed_items` is the shared timeline a member reads to
 * follow what the assistant and its tickets are doing.
 */

export const ASSISTANT_LIMITS = {
  routerBatchMax: 20,
  relatedTicketsMax: 8,
  feedContextEach: 5,
  triggerTextMax: 4000,
  feedMessageMax: 4000,
  routerSayMaxChars: 800, // ~100 words
  workerSlots: 2,
  reservedMemberSlots: 1,
  evalMaxAttempts: 3,
  consecutiveFailuresToBlock: 3,
  ticketCreditCapDefault: 500,
  workerRunTimeoutMs: 45 * 60_000,
} as const satisfies Record<string, number>;

// ── Enums ────────────────────────────────────────────────────────────────

export const assistantStatusSchema = z.enum(["active", "paused"]);
export type AssistantStatus = z.infer<typeof assistantStatusSchema>;

export const assistantStatusReasonSchema = z.enum([
  "steward_left",
  "by_admin",
]);
export type AssistantStatusReason = z.infer<
  typeof assistantStatusReasonSchema
>;

/** What put an event on the router's batch. */
export const assistantTriggerSourceSchema = z.enum([
  "member_message",
  "worker_report",
]);
export type AssistantTriggerSource = z.infer<
  typeof assistantTriggerSourceSchema
>;

export const assistantTriggerStatusSchema = z.enum([
  "pending_eval",
  "in_eval",
  "decided",
  "unavailable",
]);
export type AssistantTriggerStatus = z.infer<
  typeof assistantTriggerStatusSchema
>;

export const assistantDecisionActionSchema = z.enum([
  "create_ticket",
  "route_to_ticket",
  "ignore",
]);
export type AssistantDecisionAction = z.infer<
  typeof assistantDecisionActionSchema
>;

export const ticketStageSchema = z.enum([
  "queued",
  "working",
  "waiting_person",
  "idle",
  "ended",
]);
export type TicketStage = z.infer<typeof ticketStageSchema>;

export const ticketOutcomeSchema = z.enum([
  "ready",
  "dropped",
  "failed",
  "blocked",
  "waiting",
]);
export type TicketOutcome = z.infer<typeof ticketOutcomeSchema>;

export const ticketBlockedReasonSchema = z.enum([
  "credit_cap",
  "insufficient_credits",
  "repeated_failure",
]);
export type TicketBlockedReason = z.infer<typeof ticketBlockedReasonSchema>;

export const feedItemKindSchema = z.enum([
  "member_message",
  "router_message",
  "ticket_update",
]);
export type FeedItemKind = z.infer<typeof feedItemKindSchema>;

// ── Entities ─────────────────────────────────────────────────────────────

export const assistantSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  routerThreadId: z.string(),
  stewardUserId: z.string(),
  status: assistantStatusSchema,
  statusReason: assistantStatusReasonSchema.nullable(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Assistant = z.infer<typeof assistantSchema>;

/** How a ticket came to exist: made explicit by a member, or inferred by the router. */
export const ticketOriginSchema = z.enum(["explicit", "inferred"]);
export type TicketOrigin = z.infer<typeof ticketOriginSchema>;

export const assistantTicketSchema = z.object({
  id: z.string(),
  assistantId: z.string(),
  workerThreadId: z.string(),
  title: z.string(),
  goal: z.string(),
  payerUserId: z.string(),
  origin: ticketOriginSchema,
  stage: ticketStageSchema,
  outcome: ticketOutcomeSchema.nullable(),
  blockedReason: ticketBlockedReasonSchema.nullable(),
  creditCap: z.number(),
  consecutiveFailures: z.number().int(),
  lastReportSummary: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type AssistantTicket = z.infer<typeof assistantTicketSchema>;
export type AssistantTicketOrigin = AssistantTicket["origin"];

export const assistantFeedItemSchema = z.object({
  id: z.string(),
  assistantId: z.string(),
  kind: feedItemKindSchema,
  authorUserId: z.string().nullable(),
  text: z.string(),
  ticketId: z.string().nullable(),
  replyToItemId: z.string().nullable(),
  createdAt: z.string(),
});
export type AssistantFeedItem = z.infer<typeof assistantFeedItemSchema>;

// ── Requests ─────────────────────────────────────────────────────────────

export const postAssistantMessageRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(ASSISTANT_LIMITS.feedMessageMax),
    idempotencyKey: z.string().trim().min(1).max(256),
  })
  .strict();
export type PostAssistantMessageRequest = z.infer<
  typeof postAssistantMessageRequestSchema
>;

export const updateAssistantRequestSchema = z
  .object({
    version: z.number().int(),
    action: z.enum(["pause", "resume"]).optional(),
    stewardUserId: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.action || v.stewardUserId), {
    message: "At least one of action or stewardUserId must be provided",
  });
export type UpdateAssistantRequest = z.infer<
  typeof updateAssistantRequestSchema
>;

export const ticketActionRequestSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(256),
  })
  .strict();
export type TicketActionRequest = z.infer<typeof ticketActionRequestSchema>;

// ── Responses ────────────────────────────────────────────────────────────

export const assistantResponseSchema = z.object({
  assistant: assistantSchema.nullable(),
});
export type AssistantResponse = z.infer<typeof assistantResponseSchema>;

export const assistantFeedResponseSchema = z.object({
  items: z.array(assistantFeedItemSchema),
  nextCursor: z.string().nullable(),
});
export type AssistantFeedResponse = z.infer<
  typeof assistantFeedResponseSchema
>;

export const assistantTicketsResponseSchema = z.object({
  tickets: z.array(assistantTicketSchema),
});
export type AssistantTicketsResponse = z.infer<
  typeof assistantTicketsResponseSchema
>;

export const assistantFeedItemResponseSchema = z.object({
  item: assistantFeedItemSchema,
});
export type AssistantFeedItemResponse = z.infer<
  typeof assistantFeedItemResponseSchema
>;
