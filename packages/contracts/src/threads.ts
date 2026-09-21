import { z } from "zod";

export const threadExecutionTargetSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("cloud") }).strict(),
    z
      .object({
        kind: z.literal("local"),
        deviceId: z.string().uuid(),
        folderId: z.string().uuid().optional(),
        directoryGrantId: z.string().uuid().optional(),
      })
      .strict(),
  ])
  .refine(
    (target) =>
      target.kind !== "local" || !(target.folderId && target.directoryGrantId),
    {
      message: "Specify one working directory grant.",
    },
  );
export type ThreadExecutionTarget = z.infer<typeof threadExecutionTargetSchema>;

/** A failed run whose error cannot be rendered from a persisted assistant message. */
export type ThreadRunFailureSummary = {
  id: string;
  idempotencyKey: string;
  errorCode: string;
  errorMessage: string;
};

export const threadOriginSchema = z.enum(["user", "subagent"]);

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
  // Sub-agent conversations nest one level under the thread that hosts them.
  parentThreadId: z.string().nullable(),
  personaId: z.string().nullable(),
  origin: threadOriginSchema,
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

/**
 * How many skills may be active in one turn.
 *
 * Single source of truth for every enforcement point: the per-turn request
 * schema (a 400 at the API boundary), the backend's `resolveSelectedSkills` (a
 * typed ContentError), the web composer (silent truncation plus a toast), and a
 * thread's saved selection below. Lives here rather than in `stream.ts`, which
 * re-exports it, because `stream.ts` already imports this module.
 */
export const MAX_SELECTED_SKILLS_PER_TURN = 5;

// The skills the user checked for this conversation. Absent until the user
// makes a choice, which is what lets a thread without one follow the current
// defaults instead of freezing whatever the defaults were when it was created.
const threadSkillSelectionSchema = z
  .array(z.string().trim().min(1).max(256))
  .max(MAX_SELECTED_SKILLS_PER_TURN);

export const threadChatPreferencesSchema = z
  .object({
    thinking: threadThinkingPreferencesSchema.default({
      mode: "auto",
      effort: "medium",
    }),
    webAccess: z.boolean().default(true),
    composerOptions: z.record(z.string(), z.unknown()).default({}),
    skillIds: threadSkillSelectionSchema.optional(),
  })
  .strip();

export const updateThreadChatPreferencesRequestSchema = z
  .object({
    thinking: threadThinkingPreferencesPatchSchema.optional(),
    webAccess: z.boolean().optional(),
    composerOptions: z.record(z.string(), z.unknown()).optional(),
    skillIds: threadSkillSelectionSchema.optional(),
  })
  .strip()
  .refine(
    (value) =>
      value.thinking?.mode !== undefined ||
      value.thinking?.effort !== undefined ||
      value.webAccess !== undefined ||
      value.composerOptions !== undefined ||
      value.skillIds !== undefined,
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
  creationContextId: z.string().uuid().optional(),
  executionTarget: threadExecutionTargetSchema.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  modelSettings: threadModelSettingsInputSchema.optional(),
  chatPreferences: threadChatPreferencesSchema.optional(),
  // Start the thread as a sub-agent conversation nested under a parent.
  parentThreadId: z.string().trim().min(1).max(128).optional(),
  // The persona that owns the thread (a built-in slug such as "explore").
  personaId: z.string().trim().min(1).max(128).optional(),
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

export const threadListItemSchema = threadWithChatPreferencesSchema.extend({
  // One visible level: the sub-agent conversations nested under this thread.
  children: z.array(threadWithChatPreferencesSchema).optional(),
});

export const listThreadsResponseSchema = z.object({
  items: z.array(threadListItemSchema),
  nextCursor: z.string().nullable(),
});

export const listChildThreadsResponseSchema = z.object({
  items: z.array(threadWithChatPreferencesSchema),
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

export type ThreadOrigin = z.infer<typeof threadOriginSchema>;
export type ThreadListItem = z.infer<typeof threadListItemSchema>;
export type ListChildThreadsResponse = z.infer<
  typeof listChildThreadsResponseSchema
>;
