import { z } from "zod";

export const threadExecutionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cloud") }).strict(),
  z.object({ kind: z.literal("local"), deviceId: z.string().uuid() }).strict(),
]);
export type ThreadExecutionTarget = z.infer<typeof threadExecutionTargetSchema>;

/** A failed run whose error cannot be rendered from a persisted assistant message. */
export type ThreadRunFailureSummary = {
  id: string;
  idempotencyKey: string;
  errorCode: string;
  errorMessage: string;
};

export const threadSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  executionTarget: threadExecutionTargetSchema.optional(),
  modelSettings: z.object({
    llmProfileAlias: z.string().nullable().optional(),
    imageProfileAlias: z.string().nullable().optional(),
    visionProfileAlias: z.string().nullable().optional(),
    llmModelAlias: z.string().nullable(),
    imageModelAlias: z.string().nullable(),
    visionModelAlias: z.string().nullable(),
  }),
  sourceCount: z.number().int().nonnegative(),
  visibility: z.enum(["private", "workspace", "public_link"]),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Conversation activity time (last message append); null until the first
  // message. The sidebar sorts and shows "Xs ago" from this, not updatedAt, so
  // metadata writes (title/model/prefs) don't reshuffle the list.
  lastMessageAt: z.string().nullable(),
});

const threadThinkingEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const threadThinkingPreferencesSchema = z
  .object({
    mode: z.enum(["off", "auto", "effort"]).default("auto"),
    effort: threadThinkingEffortSchema.default("medium"),
  })
  .strip();

const threadThinkingPreferencesPatchSchema = z
  .object({
    mode: z.enum(["off", "auto", "effort"]).optional(),
    effort: threadThinkingEffortSchema.optional(),
  })
  .strip();

export const threadChatPreferencesSchema = z
  .object({
    thinking: threadThinkingPreferencesSchema.default({
      mode: "auto",
      effort: "medium",
    }),
    webAccess: z.boolean().default(true),
    composerOptions: z.record(z.string(), z.unknown()).default({}),
  })
  .strip();

export const updateThreadChatPreferencesRequestSchema = z
  .object({
    thinking: threadThinkingPreferencesPatchSchema.optional(),
    webAccess: z.boolean().optional(),
    composerOptions: z.record(z.string(), z.unknown()).optional(),
  })
  .strip()
  .refine(
    (value) =>
      value.thinking?.mode !== undefined ||
      value.thinking?.effort !== undefined ||
      value.webAccess !== undefined ||
      value.composerOptions !== undefined,
    { message: "At least one chat preference must be provided" },
  );

export const threadWithChatPreferencesSchema = threadSchema.extend({
  chatPreferences: threadChatPreferencesSchema,
});

export const threadModelSettingsInputSchema = z
  .object({
    llmProfileAlias: z.string().trim().min(1).max(512).nullable().optional(),
    imageProfileAlias: z.string().trim().min(1).max(512).nullable().optional(),
    visionProfileAlias: z.string().trim().min(1).max(512).nullable().optional(),
  })
  .strict();

export const threadModelSettingsPatchSchema =
  threadModelSettingsInputSchema.refine(
    (value) =>
      value.llmProfileAlias !== undefined ||
      value.imageProfileAlias !== undefined ||
      value.visionProfileAlias !== undefined,
    { message: "At least one model profile alias must be provided" },
  );

export const createThreadRequestSchema = z.object({
  executionTarget: threadExecutionTargetSchema.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  modelSettings: threadModelSettingsInputSchema.optional(),
  chatPreferences: threadChatPreferencesSchema.optional(),
});

export const createThreadResponseSchema = z.object({
  thread: threadWithChatPreferencesSchema,
});

export const getThreadResponseSchema = z.object({
  thread: threadWithChatPreferencesSchema,
});

export const deleteThreadResponseSchema = z.object({
  deleted: z.literal(true),
  threadId: z.string(),
});

export const listThreadsRequestSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(1024).optional(),
});

export const listThreadsResponseSchema = z.object({
  items: z.array(threadWithChatPreferencesSchema),
  nextCursor: z.string().nullable(),
});

export const threadCommandRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    arguments: z.string().max(20000).optional(),
    kind: z.enum(["tool", "skill"]).optional(),
    displayName: z.string().trim().min(1).max(256).optional(),
    skillSlug: z.string().trim().min(1).max(128).optional(),
    commandName: z.string().trim().min(1).max(128).optional(),
    toolName: z.string().trim().min(1).max(128).optional(),
    path: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export const updateThreadModelSettingsRequestSchema =
  threadModelSettingsPatchSchema;

export const updateThreadModelSettingsResponseSchema = z.object({
  thread: threadWithChatPreferencesSchema,
});

/**
 * A member may put their own thread into `private` (author-only) or `workspace`
 * (team-visible). `public_link` is reached through the separate share flow, not
 * this toggle, so it is not an accepted input here.
 */
export const updateThreadVisibilityRequestSchema = z.object({
  visibility: z.enum(["private", "workspace"]),
});

export const updateThreadVisibilityResponseSchema = z.object({
  thread: threadWithChatPreferencesSchema,
});

export const updateThreadChatPreferencesResponseSchema = z.object({
  thread: threadWithChatPreferencesSchema,
});

export const threadChatPreferencesBootstrapResponseSchema = z.object({
  initialChatPreferences: threadChatPreferencesSchema,
});

export type BaseThread = z.infer<typeof threadSchema>;
export type Thread = z.infer<typeof threadWithChatPreferencesSchema>;
export type ThreadChatPreferences = z.infer<typeof threadChatPreferencesSchema>;
export type UpdateThreadChatPreferencesRequest = z.infer<
  typeof updateThreadChatPreferencesRequestSchema
>;
export type ThreadChatPreferencesBootstrapResponse = z.infer<
  typeof threadChatPreferencesBootstrapResponseSchema
>;
export type ThreadModelSettingsPatch = z.infer<
  typeof threadModelSettingsPatchSchema
>;
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;
export type CreateThreadResponse = z.infer<typeof createThreadResponseSchema>;
export type GetThreadResponse = z.infer<typeof getThreadResponseSchema>;
export type DeleteThreadResponse = z.infer<typeof deleteThreadResponseSchema>;
export type ListThreadsRequest = z.infer<typeof listThreadsRequestSchema>;
export type ListThreadsResponse = z.infer<typeof listThreadsResponseSchema>;
export type ThreadCommandRequest = z.infer<typeof threadCommandRequestSchema>;
export type UpdateThreadModelSettingsRequest = z.infer<
  typeof updateThreadModelSettingsRequestSchema
>;
export type UpdateThreadModelSettingsResponse = z.infer<
  typeof updateThreadModelSettingsResponseSchema
>;
export type UpdateThreadVisibilityRequest = z.infer<
  typeof updateThreadVisibilityRequestSchema
>;
export type UpdateThreadVisibilityResponse = z.infer<
  typeof updateThreadVisibilityResponseSchema
>;
export type UpdateThreadChatPreferencesResponse = z.infer<
  typeof updateThreadChatPreferencesResponseSchema
>;
