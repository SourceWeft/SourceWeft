import { z } from "zod";
import {
  billingSummaryResponseSchema,
  meterConsumeResponseSchema,
  meterIngestionResponseSchema,
} from "./billing";
import { toolApprovalResumeSchema } from "./agent-confirmations";
import { AGENT_TOOL_NAMES } from "./agent-tools";

export const SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX = "sourceweft-web-run:";
export const SOURCEWEFT_WEB_RUN_STOP_SUFFIX = ":stop";

const retrievalVectorStrategySchema = z.enum([
  "ann_hnsw",
  "exact_vector",
  "bm25_only",
]);

const retrievalCitationSchema = z.object({
  citation: z.string().min(1),
  sourceId: z.string().nullable(),
  sourceTitle: z.string().optional(),
  documentId: z.string().nullable(),
  chunkId: z.string(),
  chunkNo: z.number().int().nonnegative().optional(),
  score: z.number(),
  excerpt: z.string(),
  externalUri: z.string().url().optional(),
});

const retrievalResponseSchema = z.object({
  embeddingProfileId: z.string().nullable(),
  vectorStrategy: retrievalVectorStrategySchema.nullable(),
  annIndexUsed: z.string().nullable(),
  citations: z.array(retrievalCitationSchema),
  availableCitations: z.array(retrievalCitationSchema).optional(),
});

const sourceDocumentSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  language: z.string().nullable(),
  contentText: z.string(),
  status: z.enum(["pending", "processing", "ready", "failed"]),
  tokenCount: z.number().int().nonnegative().nullable(),
  charCount: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const sourceChunkSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  chunkNo: z.number().int().nonnegative(),
  content: z.string(),
  headingPath: z.string().nullable(),
  startOffset: z.number().int().nonnegative().nullable(),
  endOffset: z.number().int().nonnegative().nullable(),
  language: z.string().nullable(),
  createdAt: z.string(),
});

const sourceEmbeddingSchema = z.object({
  id: z.string(),
  chunkId: z.string(),
  embeddingProfileId: z.string(),
  modelAlias: z.string(),
  dim: z.number().int().positive(),
  createdAt: z.string(),
});

export const sourceSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  ingestKind: z.enum([
    "connector",
    "manual_upload",
    "web_url",
    "youtube",
    "note",
    "artifact",
  ]),
  sourceType: z.enum([
    "manual_upload",
    "file_upload",
    "web_url",
    "youtube",
    "note",
    "artifact",
    "connector",
    "directory",
  ]),
  connectorId: z.string().nullable(),
  syncRunId: z.string().nullable(),
  parentSourceId: z.string().nullable(),
  title: z.string(),
  contentText: z.string(),
  externalId: z.string().nullable(),
  externalUri: z.string().nullable(),
  externalUpdatedAt: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  contentHash: z.string().nullable(),
  storageBucket: z.string().nullable(),
  storageKey: z.string().nullable(),
  previewUrl: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  status: z.enum([
    "created",
    "queued",
    "processing",
    "indexed",
    "failed",
    "archived",
  ]),
  estimatedPages: z.number().int().positive().nullable(),
  parsedTokens: z.number().int().positive().nullable(),
  parserVersion: z.string().nullable(),
  parsingConfig: z
    .object({
      chunkSize: z.number().int().positive(),
      parserVersion: z.string(),
    })
    .nullable(),
  metadata: z.record(z.string(), z.unknown()),
  error: z.record(z.string(), z.unknown()),
  createdBy: z.string().nullable(),
  indexedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const sourceRevisionSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  revisionNo: z.number().int().positive(),
  contentHash: z.string().nullable(),
  storageBucket: z.string().nullable(),
  storageKey: z.string().nullable(),
  parserVersion: z.string().nullable(),
  isLatest: z.boolean(),
  createdAt: z.string(),
});

export const sourceStatusResponseSchema = z.object({
  status: sourceSchema.shape.status,
  progress: z.number().min(0).max(100),
  currentStep: z.enum([
    "created",
    "uploading",
    "queued",
    "parsing",
    "chunking",
    "embedding",
    "completed",
    "failed",
  ]),
  parsedPages: z.number().int().nonnegative().nullable(),
  totalPages: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  jobId: z.string().nullable(),
});

export const listSourceStatusesRequestSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).max(100),
});

export const listSourceStatusesResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      status: sourceStatusResponseSchema,
    }),
  ),
});

export const bulkDeleteSourcesRequestSchema = z.object({
  sourceIds: z.array(z.string().trim().min(1)).min(1).max(100),
});

export const bulkDeleteSourcesResponseSchema = z.object({
  deleted: z.literal(true),
  sourceIds: z.array(z.string()),
  deletedCount: z.number().int().nonnegative(),
});

export const uploadSourceResponseSchema = z.object({
  source: sourceSchema,
  status: sourceStatusResponseSchema,
});

export const reparseSourceRequestSchema = z.object({
  chunkSize: z.number().int().positive().max(8192).optional(),
  forceRefresh: z.boolean().optional(),
});

export const reparseSourceResponseSchema = z.object({
  source: sourceSchema,
  status: sourceStatusResponseSchema,
  revision: sourceRevisionSchema,
});

export const sourceContentResponseSchema = z.object({
  source: sourceSchema,
  content: z.string(),
});

export const createSourceRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  contentText: z.string().max(100000).optional(),
  sourceType: z
    .enum([
      "manual_upload",
      "file_upload",
      "web_url",
      "youtube",
      "note",
      "artifact",
      "connector",
      "directory",
    ])
    .optional(),
  parentSourceId: z.string().nullable().optional(),
});

export const createSourceResponseSchema = z.object({
  source: sourceSchema,
});

export const createUrlSourceRequestSchema = z.object({
  url: z.string().trim().min(1).max(4096),
  title: z.string().trim().min(1).max(200).optional(),
  parentSourceId: z.string().nullable().optional(),
  forceRefresh: z.boolean().optional(),
});

export const createUrlSourceResponseSchema = z.object({
  source: sourceSchema,
  status: sourceStatusResponseSchema,
});

export const listSourcesResponseSchema = z.object({
  items: z.array(sourceSchema),
  nextCursor: z.string().nullable().optional(),
});

export const listSourcesRequestSchema = z.object({
  view: z.enum(["tree", "page"]).optional(),
  includeContent: z
    .union([
      z.boolean(),
      z.enum(["true", "false"]).transform((value) => value === "true"),
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).max(1024).optional(),
  parentSourceId: z.string().trim().min(1).nullable().optional(),
  connectorId: z.string().trim().min(1).optional(),
  syncRunId: z.string().trim().min(1).optional(),
  updatedAfter: z.string().datetime().optional(),
});

export const artifactSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  threadId: z.string().nullable(),
  artifactType: z.enum([
    "report",
    "slides",
    "mindmap",
    "podcast",
    "audio_overview",
    "video_overview",
    "flashcards",
    "quiz",
    "table",
    "infographic",
    "image",
  ]),
  status: z.enum(["pending", "running", "ready", "failed", "archived"]),
  title: z.string().nullable(),
  promptText: z.string().nullable(),
  payloadJson: z.record(z.string(), z.unknown()),
  storageBucket: z.string().nullable(),
  storageKey: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdBy: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  previewUrl: z.string().nullable(),
});

export const listArtifactsResponseSchema = z.object({
  items: z.array(artifactSchema),
  nextCursor: z.string().nullable().optional(),
});

const sourceMentionSchema = sourceSchema.pick({
  id: true,
  title: true,
  sourceType: true,
  parentSourceId: true,
  mimeType: true,
  status: true,
  storageKey: true,
  updatedAt: true,
});

export const listSourceMentionsRequestSchema = z.object({
  query: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().min(1).optional(),
});

export const listSourceMentionsResponseSchema = z.object({
  items: z.array(sourceMentionSchema),
  nextCursor: z.string().nullable(),
});

export const getSourceResponseSchema = z.object({
  source: sourceSchema,
  documents: z.array(sourceDocumentSchema),
  chunks: z.array(sourceChunkSchema),
  embeddings: z.array(sourceEmbeddingSchema),
  revisions: z.array(sourceRevisionSchema),
});

export const getSourceDocumentResponseSchema = getSourceResponseSchema;

export const updateSourceRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  contentText: z.string().max(100000).optional(),
  parentSourceId: z.string().nullable().optional(),
});

export const updateSourceResponseSchema = z.object({
  source: sourceSchema,
});

export const deleteSourceResponseSchema = z.object({
  deleted: z.literal(true),
  sourceId: z.string(),
});

export const indexSourceRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
});

export const indexSourceResponseSchema = z.object({
  source: sourceSchema,
  billing: meterIngestionResponseSchema,
  indexing: z.object({
    chunkCount: z.number().int().nonnegative(),
    embeddingProfileId: z.string(),
    vectorStrategy: retrievalVectorStrategySchema,
    annIndexUsed: z.string().nullable(),
  }),
});

export const retrySourceRequestSchema = z.object({
  chunkSize: z.number().int().positive().max(8192).optional(),
  forceRefresh: z.boolean().optional(),
});

export const retrySourceResponseSchema = z.discriminatedUnion("mode", [
  reparseSourceResponseSchema.extend({
    mode: z.literal("reparse"),
  }),
  indexSourceResponseSchema.extend({
    mode: z.literal("index"),
  }),
]);

export const threadSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  modelSettings: z.object({
    llmProfileAlias: z.string().nullable().optional(),
    imageProfileAlias: z.string().nullable().optional(),
    visionProfileAlias: z.string().nullable().optional(),
    llmModelAlias: z.string().nullable(),
    imageModelAlias: z.string().nullable(),
    visionModelAlias: z.string().nullable(),
  }),
  sourceCount: z.number().int().nonnegative(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
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
  title: z.string().trim().min(1).max(200).optional(),
  modelSettings: threadModelSettingsInputSchema.optional(),
});

export const createThreadResponseSchema = z.object({
  thread: threadSchema,
});

export const getThreadResponseSchema = z.object({
  thread: threadSchema,
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
  items: z.array(threadSchema),
  nextCursor: z.string().nullable(),
});

export const chatMessageTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const chatMessageImagePartSchema = z.object({
  type: z.literal("image"),
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  storageBucket: z.string().nullable().optional(),
  storageKey: z.string().optional(),
  url: z.string(),
  visionDescription: z.string().optional(),
  visionModelAlias: z.string().optional(),
  visionProfileAlias: z.string().optional(),
});

export const chatMessagePartSchema = z.discriminatedUnion("type", [
  chatMessageTextPartSchema,
  chatMessageImagePartSchema,
]);

export const messageContentJsonSchema = z
  .object({
    version: z.literal(1).optional(),
    parts: z.array(chatMessagePartSchema).optional(),
  })
  .catchall(z.unknown());

export const messageSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  threadId: z.string(),
  parentMessageId: z.string().nullable(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  contentJson: messageContentJsonSchema,
  createdBy: z.string().nullable(),
  model: z.string().nullable(),
  creditsConsumed: z.number().int().nonnegative().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

const thinkingConfigSchema = z.object({
  mode: z.enum(["auto", "off", "effort"]).optional(),
  enabled: z.boolean().optional(),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  includeReasoning: z.boolean().optional(),
});

const reasoningEffortSchema = z.enum([
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
  .refine(
    (value) => value.executionMode !== "BYOK" || !value.profileAlias,
    {
      message: "profileAlias is only valid for GLOBAL execution",
      path: ["profileAlias"],
    },
  )
  .strict();

export const streamThreadModeSchema = z.enum(["send", "refresh", "edit"]);

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

const artifactToolSelectionSchema = z
  .object({
    kind: z.literal("image"),
    mode: z.enum(["auto", "generate"]).optional(),
    modelAlias: z.string().trim().min(1).max(512).optional(),
    image: imageArtifactConfigSchema.optional(),
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

const webSearchToolSelectionSchema = z
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

const skillSlashConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
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

const skillSourceTypeSchema = z.enum([
  "builtin",
  "workspace_custom",
  "team_custom",
]);

export const skillCommandSchema = z.object({
  id: z.string(),
  name: z.string(),
  canonicalName: z.string(),
  displayName: z.string(),
  description: z.string(),
  path: z.string(),
  argumentHint: z.string().optional(),
  title: z.string().optional(),
  skillSlugs: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  slash: z.boolean().optional(),
});

export const threadCommandRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    arguments: z.string().max(20000).optional(),
    kind: z.enum(["tool", "skill", "skill-command"]).optional(),
    displayName: z.string().trim().min(1).max(256).optional(),
    skillSlug: z.string().trim().min(1).max(128).optional(),
    commandName: z.string().trim().min(1).max(128).optional(),
    toolName: z.string().trim().min(1).max(128).optional(),
    path: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

const threadToolsRequestSchema = z
  .object({
    skillIds: z.array(z.string().trim().min(1).max(128)).max(5).optional(),
    invokedSkillIds: z.array(z.string().trim().min(1).max(128)).max(5).optional(),
    webSearchEnabled: z.boolean().optional(),
    artifact: artifactToolSelectionSchema.optional(),
    [AGENT_TOOL_NAMES.generateImage]: generateImageToolSelectionSchema.optional(),
    [AGENT_TOOL_NAMES.webSearch]: webSearchToolSelectionSchema.optional(),
    [AGENT_TOOL_NAMES.searchNotionPages]:
      connectorToolSelectionSchema.optional(),
    [AGENT_TOOL_NAMES.createNotionPage]:
      connectorToolSelectionSchema.optional(),
    [AGENT_TOOL_NAMES.appendNotionPage]:
      connectorToolSelectionSchema.optional(),
    [AGENT_TOOL_NAMES.updateNotionPageByTitle]:
      connectorToolSelectionSchema.optional(),
    [AGENT_TOOL_NAMES.deleteNotionPageByTitle]:
      connectorToolSelectionSchema.optional(),
    [AGENT_TOOL_NAMES.saveArtifactToNotion]:
      connectorToolSelectionSchema.optional(),
    [AGENT_TOOL_NAMES.saveFinalAnswerToNotion]:
      connectorToolSelectionSchema.optional(),
  })
  .strict();

export const streamThreadRequestSchema = z.object({
  mode: streamThreadModeSchema.optional(),
  content: z.string().trim().max(20000).optional(),
  images: z.array(chatInputImageSchema).max(8).optional(),
  sourceIds: z.array(z.string()).max(100).optional(),
  mentionedSourceIds: z.array(z.string()).max(100).optional(),
  tools: threadToolsRequestSchema.optional(),
  command: threadCommandRequestSchema.optional(),
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
});

export const refreshThreadRequestSchema = streamThreadRequestSchema;

export const editThreadRequestSchema = streamThreadRequestSchema;

export const threadRunSummarySchema = z.object({
  id: z.string(),
  idempotencyKey: z.string(),
  status: z.enum(["queued", "running", "cancel_requested"]),
  mode: streamThreadModeSchema,
  userMessageId: z.string().nullable(),
  assistantMessageId: z.string().nullable(),
});

export const startThreadTurnRequestSchema = createThreadRequestSchema.merge(
  streamThreadRequestSchema.omit({
    mode: true,
    stream: true,
    userMessageId: true,
    assistantMessageId: true,
  }),
);

export const startThreadTurnResponseSchema = z.object({
  thread: threadSchema,
  run: threadRunSummarySchema,
});

export const streamThreadResponseSchema = z.object({
  thread: threadSchema,
  userMessage: messageSchema,
  assistantMessage: messageSchema,
  billing: meterConsumeResponseSchema,
  retrieval: retrievalResponseSchema,
});

export const refreshThreadResponseSchema = streamThreadResponseSchema;
export const editThreadResponseSchema = streamThreadResponseSchema;

export const listThreadMessagesResponseSchema = z.object({
  items: z.array(messageSchema),
  nextCursor: z.string().nullable().optional(),
});

export const listThreadMessagesRequestSchema = z.object({
  cursor: z.string().trim().min(1).max(1024).optional(),
  include: z
    .string()
    .trim()
    .max(128)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const workingFilePurposeSchema = z.enum([
  "scratch",
  "draft",
  "note",
  "output_candidate",
]);

export const workingFileSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  threadId: z.string(),
  path: z.string(),
  contentText: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  purpose: workingFilePurposeSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listWorkingFilesResponseSchema = z.object({
  items: z.array(workingFileSchema.omit({ contentText: true })),
});

export const getWorkingFileResponseSchema = z.object({
  file: workingFileSchema,
});

export const putWorkingFileRequestSchema = z
  .object({
    contentText: z.string().max(256 * 1024),
    mimeType: z.string().trim().min(1).max(128).optional(),
    purpose: workingFilePurposeSchema.nullable().optional(),
  })
  .strict();

export const putWorkingFileResponseSchema = z.object({
  file: workingFileSchema,
});

export const deleteWorkingFileResponseSchema = z.object({
  deleted: z.literal(true),
  path: z.string(),
});

export const updateThreadModelSettingsRequestSchema =
  threadModelSettingsPatchSchema;

export const workspaceSkillSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  skillId: z.string(),
  skillVersionId: z.string(),
  enabled: z.boolean(),
  configJson: z.record(z.string(), z.unknown()),
  enabledBy: z.string().nullable(),
  enabledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const skillCatalogItemSchema = z.object({
  catalogId: z.string(),
  sourceType: skillSourceTypeSchema,
  skillId: z.string(),
  skillVersionId: z.string(),
  slug: z.string(),
  name: z.string(),
  version: z.string(),
  displayName: z.string(),
  description: z.string(),
  visibility: z.enum(["public", "restricted", "workspace", "team"]),
  categories: z.array(z.string()),
  enabledWorkspaceSkillId: z.string().nullable(),
  enabled: z.boolean(),
  hasReadme: z.boolean(),
  capabilities: z
    .object({
      required: z.array(z.string()).optional(),
      optional: z.array(z.string()).optional(),
    })
    .optional(),
  models: z
    .object({
      chat: z.string().optional(),
      image: z.string().optional(),
      vision: z.string().optional(),
    })
    .optional(),
  commands: z.array(skillCommandSchema).optional(),
  tools: z.array(z.string()).optional(),
  slash: z.boolean().optional(),
  slashConfig: skillSlashConfigSchema.optional(),
  defaultConfig: z.record(z.string(), z.unknown()).optional(),
});

export const skillManifestJsonSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  version: z.string(),
  description: z.string(),
  visibility: z.enum(["public", "restricted", "workspace", "team"]),
  categories: z.array(z.string()),
  capabilities: z
    .object({
      required: z.array(z.string()).optional(),
      optional: z.array(z.string()).optional(),
    })
    .optional(),
  models: z
    .object({
      chat: z.string().optional(),
      image: z.string().optional(),
      vision: z.string().optional(),
    })
    .optional(),
  commands: z.array(skillCommandSchema).optional(),
  tools: z.array(z.string()).optional(),
  slash: z.boolean().optional(),
  slashConfig: skillSlashConfigSchema.optional(),
  defaultConfig: z.record(z.string(), z.unknown()).optional(),
});

export const listSkillsCatalogResponseSchema = z.object({
  items: z.array(skillCatalogItemSchema),
});

export const listWorkspaceSkillsResponseSchema = z.object({
  items: z.array(workspaceSkillSchema),
});

export const getSkillCatalogDetailResponseSchema = z.object({
  skill: skillCatalogItemSchema,
  readmeContent: z.string().nullable(),
  skillContent: z.string().nullable(),
});

export const enableWorkspaceSkillRequestSchema = z
  .object({
    skillId: z.string().trim().min(1).max(128),
    skillVersionId: z.string().trim().min(1).max(128),
    configJson: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const enableWorkspaceSkillResponseSchema = z.object({
  workspaceSkill: workspaceSkillSchema,
});

export const updateWorkspaceSkillRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    configJson: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const updateWorkspaceSkillResponseSchema = z.object({
  workspaceSkill: workspaceSkillSchema,
});

export const deleteWorkspaceSkillResponseSchema = z.object({
  deleted: z.literal(true),
  workspaceSkillId: z.string(),
});

const customSkillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const customSkillVersionLabelSchema = z.string().trim().min(1).max(64);

export const customSkillDefinitionSchema = z.object({
  id: z.string(),
  teamId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  sourceType: skillSourceTypeSchema,
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  visibility: z.enum(["public", "restricted", "workspace", "team"]),
  status: z.enum(["active", "archived"]),
  ownerUserId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const customSkillVersionSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  version: z.string(),
  status: z.enum(["draft", "published", "deprecated", "disabled"]),
  storageType: z.enum(["repo_builtin", "db_text"]),
  storagePointer: z.string(),
  isCurrent: z.boolean(),
  contentHash: z.string(),
  manifestJson: skillManifestJsonSchema,
  createdBy: z.string().nullable(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const customSkillVersionFileSchema = z.object({
  id: z.string(),
  skillVersionId: z.string(),
  path: z.string(),
  contentText: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  contentHash: z.string(),
  createdAt: z.string(),
});

export const customSkillSchema = z.object({
  definition: customSkillDefinitionSchema,
  version: customSkillVersionSchema,
});

export const createCustomSkillRequestSchema = z
  .object({
    name: customSkillNameSchema,
    displayName: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().min(1).max(1024),
    version: customSkillVersionLabelSchema.optional(),
  })
  .strict();

export const createCustomSkillVersionRequestSchema = z
  .object({
    version: customSkillVersionLabelSchema,
  })
  .strict();

export const updateCustomSkillVersionRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().min(1).max(1024).optional(),
  })
  .strict();

export const putCustomSkillVersionFileRequestSchema = z
  .object({
    contentText: z.string().max(256 * 1024),
    mimeType: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export const customSkillResponseSchema = z.object({
  customSkill: customSkillSchema,
});

export const putCustomSkillVersionFileResponseSchema = z.object({
  file: customSkillVersionFileSchema,
});

export const deleteCustomSkillVersionFileResponseSchema = z.object({
  deleted: z.literal(true),
  path: z.string(),
});

export const updateThreadModelSettingsResponseSchema = z.object({
  thread: threadSchema,
});

const modelCatalogKindSchema = z.enum(["llm", "image", "vision"]);

const imageModelCapabilitiesSchema = z
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

export const modelCatalogItemSchema = z.object({
  kind: modelCatalogKindSchema,
  profileAlias: z.string(),
  modelAlias: z.string(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  providerName: z.string().nullable(),
  providerKind: z.string().nullable(),
  targetModel: z.string().nullable(),
  availableViaGlobal: z.boolean().optional(),
  availableViaByokProviders: z.array(z.string()).optional(),
  displayName: z.string(),
  subtitle: z.string(),
  badges: z.array(z.string()),
  pricing: z.record(z.string(), z.unknown()).nullable(),
  capabilities: z
    .object({
      supportsThinking: z.boolean(),
      supportsImageInput: z.boolean().optional(),
      supportedParameters: z.array(z.string()),
      supportedEfforts: z.array(reasoningEffortSchema),
      reasoning: z.boolean(),
      reasoningEffort: z.boolean(),
      includeReasoning: z.boolean(),
      supportSources: z.array(z.string()),
      imageGeneration: imageModelCapabilitiesSchema.optional(),
    })
    .optional(),
});

export const listThreadModelCatalogResponseSchema = z.object({
  defaults: threadSchema.shape.modelSettings,
  kinds: z.object({
    llm: z.array(modelCatalogItemSchema),
    image: z.array(modelCatalogItemSchema),
    vision: z.array(modelCatalogItemSchema),
  }),
});

export const byokCredentialSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  userId: z.string().nullable(),
  providerName: z.string(),
  providerKind: z.string(),
  baseUrl: z.string().nullable(),
  credentialAlias: z.string(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  isActive: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listByokCredentialsResponseSchema = z.object({
  items: z.array(byokCredentialSchema),
});

export const createByokCredentialRequestSchema = z.object({
  providerName: z.string().trim().min(1).max(100),
  credentialAlias: z.string().trim().min(1).max(256),
  apiKey: z.string().trim().min(1).max(4096),
  providerKind: z.string().trim().min(1).max(100).optional(),
  baseUrl: z.string().trim().url().max(2048).optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const createByokCredentialResponseSchema = z.object({
  item: byokCredentialSchema,
});

export const deleteByokCredentialResponseSchema = z.object({
  deleted: z.literal(true),
  credentialId: z.string(),
});

export const byokProviderSchema = z.object({
  providerName: z.string(),
  providerKind: z.string(),
  baseUrl: z.string().nullable(),
  system: z.boolean(),
  isBYOKOnly: z.boolean().optional(),
  hasApiKey: z.boolean().optional(),
  credentialAliases: z.array(z.string()).optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
});

export const listByokProvidersResponseSchema = z.object({
  items: z.array(byokProviderSchema),
});

export const resolveByokModelCapabilitiesRequestSchema = z.object({
  modelName: z.string().trim().min(1).max(256),
});

export const resolvedByokModelCapabilitiesSchema = z.object({
  supportsThinking: z.boolean(),
  supportsImageInput: z.boolean().optional(),
  supportedParameters: z.array(z.string()),
  supportedEfforts: z.array(reasoningEffortSchema),
  reasoning: z.boolean(),
  reasoningEffort: z.boolean(),
  includeReasoning: z.boolean(),
  supportSources: z.array(z.string()),
  maxCompletionTokens: z.number().nullable().optional(),
  litellmKey: z.string().optional(),
});

export const resolveByokModelCapabilitiesResponseSchema = z.object({
  capabilities: resolvedByokModelCapabilitiesSchema.nullable(),
});

export const byokModelCandidateSchema = z.object({
  modelId: z.string(),
  displayName: z.string(),
});

export const listByokModelCandidatesResponseSchema = z.object({
  items: z.array(byokModelCandidateSchema),
});

export const byokModelSchema = z.object({
  id: z.string(),
  credentialId: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  userId: z.string().nullable(),
  providerName: z.string(),
  modelName: z.string(),
  displayName: z.string(),
  modelType: modelCatalogKindSchema,
  capabilities: z.record(z.string(), z.unknown()).nullable().optional(),
  config: z.record(z.string(), z.unknown()),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listByokModelsResponseSchema = z.object({
  items: z.array(byokModelSchema),
});

export const addByokModelRequestSchema = z.object({
  credentialId: z.string().trim().min(1).max(256),
  modelName: z.string().trim().min(1).max(512),
  displayName: z.string().trim().min(1).max(256).optional(),
  modelType: modelCatalogKindSchema,
  config: z.record(z.string(), z.unknown()).optional(),
});

export const addByokModelResponseSchema = z.object({
  item: byokModelSchema,
});

export const deleteByokModelResponseSchema = z.object({
  deleted: z.literal(true),
  modelId: z.string(),
});

export const citationDetailResponseSchema = z.object({
  citation: retrievalCitationSchema,
});

export const billingDashboardResponseSchema = z.object({
  summary: billingSummaryResponseSchema,
});

export type Source = z.infer<typeof sourceSchema>;
export type CreateSourceRequest = z.infer<typeof createSourceRequestSchema>;
export type CreateSourceResponse = z.infer<typeof createSourceResponseSchema>;
export type CreateUrlSourceRequest = z.infer<
  typeof createUrlSourceRequestSchema
>;
export type CreateUrlSourceResponse = z.infer<
  typeof createUrlSourceResponseSchema
>;
export type ListSourcesResponse = z.infer<typeof listSourcesResponseSchema>;
export type ListSourcesRequest = z.infer<typeof listSourcesRequestSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ListArtifactsResponse = z.infer<
  typeof listArtifactsResponseSchema
>;
export type SourceMention = z.infer<typeof sourceMentionSchema>;
export type ListSourceMentionsRequest = z.infer<
  typeof listSourceMentionsRequestSchema
>;
export type ListSourceMentionsResponse = z.infer<
  typeof listSourceMentionsResponseSchema
>;
export type GetSourceResponse = z.infer<typeof getSourceResponseSchema>;
export type GetSourceDocumentResponse = z.infer<
  typeof getSourceDocumentResponseSchema
>;
export type SourceStatusResponse = z.infer<typeof sourceStatusResponseSchema>;
export type ListSourceStatusesRequest = z.infer<
  typeof listSourceStatusesRequestSchema
>;
export type ListSourceStatusesResponse = z.infer<
  typeof listSourceStatusesResponseSchema
>;
export type BulkDeleteSourcesRequest = z.infer<
  typeof bulkDeleteSourcesRequestSchema
>;
export type BulkDeleteSourcesResponse = z.infer<
  typeof bulkDeleteSourcesResponseSchema
>;
export type UploadSourceResponse = z.infer<typeof uploadSourceResponseSchema>;
export type UpdateSourceRequest = z.infer<typeof updateSourceRequestSchema>;
export type UpdateSourceResponse = z.infer<typeof updateSourceResponseSchema>;
export type DeleteSourceResponse = z.infer<typeof deleteSourceResponseSchema>;
export type ReparseSourceRequest = z.infer<typeof reparseSourceRequestSchema>;
export type ReparseSourceResponse = z.infer<typeof reparseSourceResponseSchema>;
export type RetrySourceRequest = z.infer<typeof retrySourceRequestSchema>;
export type RetrySourceResponse = z.infer<typeof retrySourceResponseSchema>;
export type SourceContentResponse = z.infer<typeof sourceContentResponseSchema>;
export type IndexSourceRequest = z.infer<typeof indexSourceRequestSchema>;
export type IndexSourceResponse = z.infer<typeof indexSourceResponseSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type ThreadModelSettingsPatch = z.infer<
  typeof threadModelSettingsPatchSchema
>;
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;
export type CreateThreadResponse = z.infer<typeof createThreadResponseSchema>;
export type ThreadRunSummary = z.infer<typeof threadRunSummarySchema>;
export type StartThreadTurnRequest = z.infer<
  typeof startThreadTurnRequestSchema
>;
export type StartThreadTurnResponse = z.infer<
  typeof startThreadTurnResponseSchema
>;
export type GetThreadResponse = z.infer<typeof getThreadResponseSchema>;
export type DeleteThreadResponse = z.infer<typeof deleteThreadResponseSchema>;
export type ListThreadsRequest = z.infer<typeof listThreadsRequestSchema>;
export type ListThreadsResponse = z.infer<typeof listThreadsResponseSchema>;
export type ChatMessageTextPart = z.infer<typeof chatMessageTextPartSchema>;
export type ChatMessageImagePart = z.infer<typeof chatMessageImagePartSchema>;
export type ChatMessagePart = z.infer<typeof chatMessagePartSchema>;
export type MessageContentJson = z.infer<typeof messageContentJsonSchema>;
export type Message = z.infer<typeof messageSchema>;
export type ChatInputImage = z.infer<typeof chatInputImageSchema>;
export type StreamThreadMode = z.infer<typeof streamThreadModeSchema>;
export type ImageStyle = z.infer<typeof imageStyleSchema>;
export type ImageAspectRatio = z.infer<typeof imageAspectRatioSchema>;
export type ImageQuality = z.infer<typeof imageQualitySchema>;
export type ImageArtifactConfig = z.infer<typeof imageArtifactConfigSchema>;
export type ArtifactToolSelection = z.infer<typeof artifactToolSelectionSchema>;
export type GenerateImageToolSelection = z.infer<
  typeof generateImageToolSelectionSchema
>;
export type WebSearchToolSelection = z.infer<
  typeof webSearchToolSelectionSchema
>;
export type SkillCommand = z.infer<typeof skillCommandSchema>;
export type ThreadCommandRequest = z.infer<typeof threadCommandRequestSchema>;
export type StreamThreadRequest = z.infer<typeof streamThreadRequestSchema>;
export type StreamThreadResponse = z.infer<typeof streamThreadResponseSchema>;
export type RefreshThreadRequest = z.infer<typeof refreshThreadRequestSchema>;
export type RefreshThreadResponse = z.infer<typeof refreshThreadResponseSchema>;
export type EditThreadRequest = z.infer<typeof editThreadRequestSchema>;
export type EditThreadResponse = z.infer<typeof editThreadResponseSchema>;
export type ListThreadMessagesResponse = z.infer<
  typeof listThreadMessagesResponseSchema
>;
export type ListThreadMessagesRequest = z.infer<
  typeof listThreadMessagesRequestSchema
>;
export type WorkingFilePurpose = z.infer<typeof workingFilePurposeSchema>;
export type WorkingFile = z.infer<typeof workingFileSchema>;
export type ListWorkingFilesResponse = z.infer<
  typeof listWorkingFilesResponseSchema
>;
export type GetWorkingFileResponse = z.infer<
  typeof getWorkingFileResponseSchema
>;
export type PutWorkingFileRequest = z.infer<typeof putWorkingFileRequestSchema>;
export type PutWorkingFileResponse = z.infer<
  typeof putWorkingFileResponseSchema
>;
export type DeleteWorkingFileResponse = z.infer<
  typeof deleteWorkingFileResponseSchema
>;
export type UpdateThreadModelSettingsRequest = z.infer<
  typeof updateThreadModelSettingsRequestSchema
>;
export type UpdateThreadModelSettingsResponse = z.infer<
  typeof updateThreadModelSettingsResponseSchema
>;
export type WorkspaceSkill = z.infer<typeof workspaceSkillSchema>;
export type SkillCatalogItem = z.infer<typeof skillCatalogItemSchema>;
export type ListSkillsCatalogResponse = z.infer<
  typeof listSkillsCatalogResponseSchema
>;
export type ListWorkspaceSkillsResponse = z.infer<
  typeof listWorkspaceSkillsResponseSchema
>;
export type GetSkillCatalogDetailResponse = z.infer<
  typeof getSkillCatalogDetailResponseSchema
>;
export type EnableWorkspaceSkillRequest = z.infer<
  typeof enableWorkspaceSkillRequestSchema
>;
export type EnableWorkspaceSkillResponse = z.infer<
  typeof enableWorkspaceSkillResponseSchema
>;
export type UpdateWorkspaceSkillRequest = z.infer<
  typeof updateWorkspaceSkillRequestSchema
>;
export type UpdateWorkspaceSkillResponse = z.infer<
  typeof updateWorkspaceSkillResponseSchema
>;
export type DeleteWorkspaceSkillResponse = z.infer<
  typeof deleteWorkspaceSkillResponseSchema
>;
export type CustomSkillDefinition = z.infer<typeof customSkillDefinitionSchema>;
export type CustomSkillVersion = z.infer<typeof customSkillVersionSchema>;
export type CustomSkillVersionFile = z.infer<
  typeof customSkillVersionFileSchema
>;
export type CustomSkill = z.infer<typeof customSkillSchema>;
export type CreateCustomSkillRequest = z.infer<
  typeof createCustomSkillRequestSchema
>;
export type CreateCustomSkillVersionRequest = z.infer<
  typeof createCustomSkillVersionRequestSchema
>;
export type UpdateCustomSkillVersionRequest = z.infer<
  typeof updateCustomSkillVersionRequestSchema
>;
export type PutCustomSkillVersionFileRequest = z.infer<
  typeof putCustomSkillVersionFileRequestSchema
>;
export type CustomSkillResponse = z.infer<typeof customSkillResponseSchema>;
export type PutCustomSkillVersionFileResponse = z.infer<
  typeof putCustomSkillVersionFileResponseSchema
>;
export type DeleteCustomSkillVersionFileResponse = z.infer<
  typeof deleteCustomSkillVersionFileResponseSchema
>;
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;
export type ListThreadModelCatalogResponse = z.infer<
  typeof listThreadModelCatalogResponseSchema
>;

export type ByokCredential = z.infer<typeof byokCredentialSchema>;
export type ByokModel = z.infer<typeof byokModelSchema>;
export type ByokProvider = z.infer<typeof byokProviderSchema>;
export type ListByokCredentialsResponse = z.infer<
  typeof listByokCredentialsResponseSchema
>;
export type ListByokModelsResponse = z.infer<
  typeof listByokModelsResponseSchema
>;
export type ByokModelCandidate = z.infer<typeof byokModelCandidateSchema>;
export type ListByokModelCandidatesResponse = z.infer<
  typeof listByokModelCandidatesResponseSchema
>;
export type ListByokProvidersResponse = z.infer<
  typeof listByokProvidersResponseSchema
>;
export type CreateByokCredentialRequest = z.infer<
  typeof createByokCredentialRequestSchema
>;
export type CreateByokCredentialResponse = z.infer<
  typeof createByokCredentialResponseSchema
>;
export type DeleteByokCredentialResponse = z.infer<
  typeof deleteByokCredentialResponseSchema
>;
export type ResolveByokModelCapabilitiesRequest = z.infer<
  typeof resolveByokModelCapabilitiesRequestSchema
>;
export type ResolveByokModelCapabilitiesResponse = z.infer<
  typeof resolveByokModelCapabilitiesResponseSchema
>;
export type AddByokModelRequest = z.infer<typeof addByokModelRequestSchema>;
export type AddByokModelResponse = z.infer<typeof addByokModelResponseSchema>;
export type DeleteByokModelResponse = z.infer<
  typeof deleteByokModelResponseSchema
>;
export type CitationDetailResponse = z.infer<
  typeof citationDetailResponseSchema
>;
