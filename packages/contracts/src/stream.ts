import { z } from "zod";
import { toolApprovalResumeSchema } from "./agent-confirmations";
import { APPEND_NOTION_PAGE_TOOL_NAME, CREATE_NOTION_PAGE_TOOL_NAME, DELETE_NOTION_PAGE_TOOL_NAME, GENERATE_IMAGE_TOOL_NAME, GENERATE_VIDEO_PRESENTATION_TOOL_NAME, PUBLISH_ARTIFACT_TOOL_NAME, READ_NOTION_PAGE_TOOL_NAME, SAVE_ARTIFACT_TO_NOTION_TOOL_NAME, SAVE_FINAL_ANSWER_TO_NOTION_TOOL_NAME, SEARCH_NOTION_PAGES_TOOL_NAME, UPDATE_NOTION_PAGE_TOOL_NAME, WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "./agent-tools";
import { meterConsumeResponseSchema } from "./billing";
import {
  capabilityOptionModelValuesSchema,
  capabilityOptionValueSchema,
} from "./capabilities";
import { messageSchema } from "./messages";
import { skillRuntimeConfigSelectionSchema } from "./skills";
import { retrievalResponseSchema } from "./sources";
import { createThreadRequestSchema, threadCommandRequestSchema, threadModelSettingsInputSchema, threadWithChatPreferencesSchema } from "./threads";
import { videoPresentationBrandSchema, videoPresentationCanvasSchema, videoPresentationMotionSchema, videoPresentationRenderProfileSchema } from "./video-presentation";

const thinkingConfigSchema = z.object({
  mode: z.enum(["auto", "off", "effort"]).optional(),
  enabled: z.boolean().optional(),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  includeReasoning: z.boolean().optional(),
});

export const reasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const llmExecutionConfigSchema = z
  .object({
    profileAlias: z.string().trim().min(1).max(512).optional(),
    modelAlias: z.string().trim().min(1).max(512).optional(),
    providerModel: z.string().trim().min(1).max(512).optional(),
    executionMode: z.enum(["GLOBAL", "BYOK"]).optional(),
    providerHint: z.string().trim().min(1).max(100).optional(),
    byokModelId: z.string().trim().min(1).max(256).optional(),
    credentialId: z.string().trim().min(1).max(256).optional(),
    thinking: thinkingConfigSchema.optional(),
  })
  .refine(
    (value) => {
      if (value.executionMode !== "BYOK") {
        return true;
      }

      if (value.byokModelId) {
        return true;
      }

      return false;
    },
    {
      message: "BYOK execution requires byokModelId",
      path: ["byokModelId"],
    },
  )
  .refine((value) => value.executionMode !== "BYOK" || !value.profileAlias, {
    message: "profileAlias is only valid for GLOBAL execution",
    path: ["profileAlias"],
  })
  .strict();

export const streamThreadModeSchema = z.enum([
  "send",
  "refresh",
  "edit",
  "resume",
]);

export const imageStyleSchema = z.enum([
  "auto",
  "ghibli",
  "pixar",
  "cartoon",
  "pixel",
]);

export const imageAspectRatioSchema = z.enum([
  "auto",
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
  "1:4",
  "4:1",
  "1:8",
  "8:1",
]);

export const imageQualitySchema = z.enum([
  "auto",
  "low",
  "standard",
  "higher",
  "highest",
]);

const imageArtifactConfigSchema = z
  .object({
    aspectRatio: imageAspectRatioSchema.optional(),
    quality: imageQualitySchema.optional(),
    style: imageStyleSchema.optional(),
  })
  .strict();

const generateImageToolSelectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(["auto", "generate"]).optional(),
    modelAlias: z.string().trim().min(1).max(512).optional(),
    execution: llmExecutionConfigSchema.optional(),
    config: imageArtifactConfigSchema.optional(),
  })
  .strict();

const publishArtifactToolSelectionSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

const generateVideoPresentationToolSelectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    language: z.string().trim().min(1).max(20).optional(),
    durationTarget:
      videoPresentationRenderProfileSchema.shape.durationTarget.optional(),
    stylePreset:
      videoPresentationRenderProfileSchema.shape.stylePreset.optional(),
    renderProfile: videoPresentationRenderProfileSchema.partial().optional(),
    slideCount: z.number().int().min(1).max(12).optional(),
    visualDirection: z.string().trim().min(1).max(1000).optional(),
    brand: videoPresentationBrandSchema.optional(),
    motion: videoPresentationMotionSchema.optional(),
    canvas: videoPresentationCanvasSchema.optional(),
    narration: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const webToolSelectionSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

const connectorToolSelectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    connectorId: z.string().trim().min(1).optional(),
  })
  .strict();

export const chatInputImageSchema = z
  .object({
    dataUrl: z
      .string()
      .trim()
      .min(1)
      .max(16 * 1024 * 1024)
      .regex(/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i),
    fileName: z.string().trim().min(1).max(255).optional(),
    mimeType: z
      .enum(["image/png", "image/jpeg", "image/webp", "image/gif"])
      .optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();

const invocationSelectionRequestSchema = z
  .object({
    selectableId: z.string().trim().min(1).max(256),
    userInput: z.string().max(20000),
    structuredArgs: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const capabilityToolOptionSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    valueType: z.enum(["string", "number", "boolean"]),
    defaultValue: capabilityOptionValueSchema.optional(),
    target: z
      .object({
        path: z.string(),
      })
      .optional(),
    // Present when the capability says this option's values depend on the
    // selected model; the client narrows the picker through it without knowing
    // what the option is.
    modelValues: capabilityOptionModelValuesSchema.optional(),
    values: z.array(
      z.object({
        value: capabilityOptionValueSchema,
        label: z.string().optional(),
      }),
    ),
  })
  .strict();

const capabilityCatalogCommandSchema = z
  .object({
    id: z.string(),
    capabilityId: z.string(),
    contributionId: z.string(),
    title: z.string(),
    displayTitle: z.string(),
    parentKind: z
      .enum([
        "command",
        "skill",
        "tool",
        "vfs",
        "artifact",
        "retrieval",
        "document_parser",
        "mcp",
        "connector",
      ])
      .nullable(),
    parentTitle: z.string().nullable(),
    aliases: z.array(z.string()),
    category: z.string().nullable(),
    iconName: z.string().optional(),
    iconTone: z.enum(["brand", "mono"]).optional(),
    visible: z.boolean(),
    order: z.number(),
    action: z.object({
      kind: z.enum([
        "command",
        "skill",
        "tool",
        "vfs",
        "artifact",
        "retrieval",
        "document_parser",
        "mcp",
        "connector",
      ]),
      targetId: z.string(),
    }),
    hasWorkflow: z.boolean(),
    sourcePackageName: z.string().nullable(),
  })
  .strict();

const capabilityCatalogToolSchema = z
  .object({
    id: z.string(),
    capabilityId: z.string(),
    contributionId: z.string(),
    title: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()),
    options: z.array(capabilityToolOptionSchema),
    risk: z.enum(["read", "write", "destructive", "unknown"]),
    sourcePackageName: z.string().nullable(),
    toolName: z.string(),
  })
  .strict();

export const listCapabilityCatalogResponseSchema = z.object({
  commands: z.array(capabilityCatalogCommandSchema),
  tools: z.array(capabilityCatalogToolSchema),
});

/**
 * How many skills may be active in one turn.
 *
 * Single source of truth for all three enforcement points: this schema (a 400
 * at the API boundary), the backend's `resolveSelectedSkills` (a typed
 * ContentError), and the web composer (silent truncation plus a toast). They
 * were three independent literals; changing one desynced the others silently.
 */
export const MAX_SELECTED_SKILLS_PER_TURN = 5;

/**
 * Unknown keys are passed through on purpose: `buildRuntimeTools` treats every
 * non-reserved key as a tool name, which is how connector and capability tools
 * — whose names are not known at contract-authoring time — reach the turn. The
 * schema therefore cannot be strict, and a misspelled tool key becomes an inert
 * runtime-tool entry rather than a validation error.
 */
const threadToolsRequestSchema = z
  .object({
    skillIds: z
      .array(z.string().trim().min(1).max(128))
      .max(MAX_SELECTED_SKILLS_PER_TURN)
      .default([]),
    invokedSkillIds: z
      .array(z.string().trim().min(1).max(128))
      .max(MAX_SELECTED_SKILLS_PER_TURN)
      .optional(),
    skillRuntimeConfig: skillRuntimeConfigSelectionSchema.optional(),
    [GENERATE_IMAGE_TOOL_NAME]: generateImageToolSelectionSchema.optional(),
    [PUBLISH_ARTIFACT_TOOL_NAME]:
      publishArtifactToolSelectionSchema.optional(),
    [GENERATE_VIDEO_PRESENTATION_TOOL_NAME]:
      generateVideoPresentationToolSelectionSchema.optional(),
    [WEB_SEARCH_TOOL_NAME]: webToolSelectionSchema.optional(),
    [WEB_FETCH_TOOL_NAME]: webToolSelectionSchema.optional(),
    [SEARCH_NOTION_PAGES_TOOL_NAME]: connectorToolSelectionSchema.optional(),
    [READ_NOTION_PAGE_TOOL_NAME]: connectorToolSelectionSchema.optional(),
    [CREATE_NOTION_PAGE_TOOL_NAME]: connectorToolSelectionSchema.optional(),
    [APPEND_NOTION_PAGE_TOOL_NAME]: connectorToolSelectionSchema.optional(),
    [UPDATE_NOTION_PAGE_TOOL_NAME]: connectorToolSelectionSchema.optional(),
    [DELETE_NOTION_PAGE_TOOL_NAME]: connectorToolSelectionSchema.optional(),
    [SAVE_ARTIFACT_TO_NOTION_TOOL_NAME]:
      connectorToolSelectionSchema.optional(),
    [SAVE_FINAL_ANSWER_TO_NOTION_TOOL_NAME]:
      connectorToolSelectionSchema.optional(),
    // MCP selection as the web client sends it (sources-hub picker). The
    // backend reads installIds from here (see preparer) — the legacy top-level
    // mcpInstallIds field remains supported for API callers.
    mcp: z
      .object({
        enabled: z.boolean().optional(),
        installIds: z
          .array(z.string().trim().min(1).max(128))
          .max(10)
          .default([]),
        toolIds: z.array(z.string().trim().min(1).max(128)).max(200).optional(),
      })
      .optional(),
  })
  .catchall(z.unknown());

export const streamThreadRequestSchema = z.object({
  mode: streamThreadModeSchema.optional(),
  content: z.string().trim().max(20000).optional(),
  images: z.array(chatInputImageSchema).max(8).optional(),
  sourceIds: z.array(z.string()).max(100).optional(),
  mentionedSourceIds: z.array(z.string()).max(100).optional(),
  tools: threadToolsRequestSchema.optional(),
  command: threadCommandRequestSchema.optional(),
  invocation: invocationSelectionRequestSchema.optional(),
  stream: z.boolean().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  userMessageId: z.string().trim().min(1).max(128).optional(),
  assistantMessageId: z.string().trim().min(1).max(128).optional(),
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
  llm: llmExecutionConfigSchema.optional(),
  image: llmExecutionConfigSchema.optional(),
  vision: llmExecutionConfigSchema.optional(),
  modelSettings: threadModelSettingsInputSchema.optional(),
  toolApprovalResume: toolApprovalResumeSchema.optional(),
  mcpInstallIds: z.array(z.string().trim().min(1).max(128)).max(10).optional(),
});

export const refreshThreadRequestSchema = streamThreadRequestSchema
  .omit({ toolApprovalResume: true })
  .extend({
    mode: z.literal("refresh").optional(),
  });

export const resumeThreadRequestSchema = streamThreadRequestSchema.extend({
  mode: z.literal("resume").optional(),
  assistantMessageId: z.string().trim().min(1).max(128),
  toolApprovalResume: toolApprovalResumeSchema,
});

export const editThreadRequestSchema = streamThreadRequestSchema
  .omit({ toolApprovalResume: true })
  .extend({
    mode: z.literal("edit").optional(),
  });

/**
 * Mirrors ChatThreadRunStatus in @sourceweft/db, terminal states included.
 * Omitting them would force presenters to misreport a finished run as still
 * queued.
 */
export const threadRunStatusSchema = z.enum([
  "queued",
  "running",
  "cancel_requested",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
]);

export const threadRunSummarySchema = z.object({
  id: z.string(),
  idempotencyKey: z.string(),
  status: threadRunStatusSchema,
  mode: streamThreadModeSchema,
  // The member who initiated the run. Lets clients distinguish "my run" (which
  // locks my composer) from another member's run on a shared thread (which I
  // follow live but which must not lock my composer).
  userId: z.string(),
  userMessageId: z.string().nullable(),
  assistantMessageId: z.string().nullable(),
  approvalRequestedAt: z.string().nullable().optional(),
  approvalExpiresAt: z.string().nullable().optional(),
});

export const startThreadTurnRequestSchema = createThreadRequestSchema.merge(
  streamThreadRequestSchema.omit({
    mode: true,
    stream: true,
    toolApprovalResume: true,
    userMessageId: true,
    assistantMessageId: true,
  }),
);

export const startThreadTurnResponseSchema = z.object({
  thread: threadWithChatPreferencesSchema,
  run: threadRunSummarySchema,
});

export const streamThreadResponseSchema = z.object({
  thread: threadWithChatPreferencesSchema,
  userMessage: messageSchema,
  assistantMessage: messageSchema,
  billing: meterConsumeResponseSchema,
  retrieval: retrievalResponseSchema,
});

export const refreshThreadResponseSchema = streamThreadResponseSchema;
export const resumeThreadResponseSchema = streamThreadResponseSchema;
export const editThreadResponseSchema = streamThreadResponseSchema;

export const listThreadMessagesResponseSchema = z.object({
  items: z.array(messageSchema),
  nextCursor: z.string().nullable().optional(),
});

export const listThreadMessagesRequestSchema = z.object({
  cursor: z.string().trim().min(1).max(1024).optional(),
  // Forward cursor (strictly newer, ascending) for reconcile-on-connect in live
  // collaboration. Mutually exclusive with `cursor` (backward); `after` wins.
  after: z.string().trim().min(1).max(1024).optional(),
  include: z.string().trim().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const imageModelCapabilitiesSchema = z
  .object({
    supported: z.boolean(),
    provider: z.string().optional(),
    supportedParameters: z.array(z.string()).optional(),
    controls: z
      .object({
        aspectRatio: z
          .object({
            values: z.array(imageAspectRatioSchema),
          })
          .optional(),
        quality: z
          .object({
            values: z.array(imageQualitySchema),
          })
          .optional(),
        style: z
          .object({
            values: z.array(imageStyleSchema),
          })
          .optional(),
      })
      .strict(),
    maxVariants: z.number().int().positive().optional(),
  })
  .strict();

export type ThreadRunSummary = z.infer<typeof threadRunSummarySchema>;
export type StartThreadTurnRequest = z.infer<
  typeof startThreadTurnRequestSchema
>;
export type StartThreadTurnResponse = z.infer<
  typeof startThreadTurnResponseSchema
>;
export type ChatInputImage = z.infer<typeof chatInputImageSchema>;
export type StreamThreadMode = z.infer<typeof streamThreadModeSchema>;
export type ImageStyle = z.infer<typeof imageStyleSchema>;
export type ImageAspectRatio = z.infer<typeof imageAspectRatioSchema>;
export type ImageQuality = z.infer<typeof imageQualitySchema>;
export type ImageArtifactConfig = z.infer<typeof imageArtifactConfigSchema>;
export type GenerateImageToolSelection = z.infer<
  typeof generateImageToolSelectionSchema
>;
export type PublishArtifactToolSelection = z.infer<
  typeof publishArtifactToolSelectionSchema
>;
export type GenerateVideoPresentationToolSelection = z.infer<
  typeof generateVideoPresentationToolSelectionSchema
>;
export type WebSearchToolSelection = z.infer<typeof webToolSelectionSchema>;
export type WebFetchToolSelection = z.infer<typeof webToolSelectionSchema>;
export type CapabilityToolOption = z.infer<typeof capabilityToolOptionSchema>;
export type CapabilityCatalogCommand = z.infer<
  typeof capabilityCatalogCommandSchema
>;
export type CapabilityCatalogTool = z.infer<typeof capabilityCatalogToolSchema>;
export type ListCapabilityCatalogResponse = z.infer<
  typeof listCapabilityCatalogResponseSchema
>;
export type ThreadInvocationRequest = z.infer<
  typeof invocationSelectionRequestSchema
>;
export type StreamThreadRequest = z.infer<typeof streamThreadRequestSchema>;
export type StreamThreadResponse = z.infer<typeof streamThreadResponseSchema>;
export type RefreshThreadRequest = z.infer<typeof refreshThreadRequestSchema>;
export type RefreshThreadResponse = z.infer<typeof refreshThreadResponseSchema>;
export type ResumeThreadRequest = z.infer<typeof resumeThreadRequestSchema>;
export type ResumeThreadResponse = z.infer<typeof resumeThreadResponseSchema>;
export type EditThreadRequest = z.infer<typeof editThreadRequestSchema>;
export type EditThreadResponse = z.infer<typeof editThreadResponseSchema>;
export type ListThreadMessagesResponse = z.infer<
  typeof listThreadMessagesResponseSchema
>;
export type ListThreadMessagesRequest = z.infer<
  typeof listThreadMessagesRequestSchema
>;
