import { randomUUID } from "node:crypto";
import type {
  ChatCompleteResult,
  RouteDecision,
  UsageInfo,
} from "@sourceweft/model-gateway";
import sharp from "sharp";
import type { LlmExecutionConfig } from "../../content/model-gateway-audit";
import type { ContentBillingPort } from "../../content/billing-port";
import type { MessageRecord } from "../../content/types";
import { resolveModelGatewayProfile } from "../../../shared/model-gateway/client";
import { openBilledModelGateway } from "../../../shared/model-gateway";
import type {
  BilledModelGateway,
  BilledRequestOptions,
  MeteredModelCallTrace,
} from "../../../shared/model-gateway";
import type { MeterUsageFn } from "../../../shared/model-gateway/billing/settle";
import { ContentError } from "../../content/errors";
import { contentByokService } from "../../byok";
import { dedupeSourceIds } from "../../sources/source-ids";
import { requireContentWorkspace } from "../../workspace/guards";
import { workspaceService } from "../../workspace";
import type { SelectableInvocationRegistry } from "../../invocations/registry";
import {
  findThreadRecord,
  updateThreadModelSettingsRecord,
} from "../thread/repository";
import {
  createMessageRecord,
  findMessageRecord,
  listMessageRecordsByThread,
  updateMessageMetadataRecord,
} from "../message-repository";
import {
  normalizeThreadModelSettings,
  applyResolvedThreadModelSettings,
  pruneUnavailableThreadModelAliases,
  resolveThreadModelSettingsSnapshots,
  validateThreadModelSettings,
  MODEL_KIND_BY_THREAD_KIND,
  type ThreadModelKind,
  type ThreadModelSettings,
} from "../model-settings";
import {
  collapseSupersededMessages,
  filterMessagesBeforeEditAnchor,
  isContextExcludedMessage,
  resolveAgentCheckpointMetadata,
  resolveSourceIdsFromMessage,
} from "./context";
import {
  resolveActiveChatProfileByAlias,
  resolveThreadChatProfile,
} from "./model-resolution";
import { assertSourcesExist } from "./source-validation";
import {
  lastToolCommandMarker,
  markerSourceIds,
  markerSourceTitles,
  parsePromptMarkers,
} from "./thread-command-markers";
import {
  buildCommandAugmentedText,
  buildThreadCommandMetadata,
} from "./thread-command-render";
import { resolveRequestedThreadProfileAlias } from "./requested-profile-alias";
import {
  buildDefaultTurnInvocationRegistry,
  buildInvocationAugmentedText,
  buildTurnInvocationRegistry,
  resolveThreadInvocation,
} from "./thread-invocation";
import {
  parseRequestedCommand,
  resolveThreadCommand,
  resolveToolCommandName,
} from "./thread-command";
import {
  applyCapabilityToolOptionDefaults,
  mergeSelectedSkillRuntimeTools,
  mergeCommandTools,
  mergeInvocationTools,
  resolveMarkerToolSelection,
  resolveToolPermissions,
} from "./thread-command-tools";
import type {
  PreparedThreadTurn,
  ConnectorToolSelection,
  StreamThreadEventInput,
} from "./types";
import {
  resolveSourceIdsByTitles,
  resolveSourceTreeScope,
} from "../../sources/service";
import type { EnabledSkillDescriptor } from "../../skills/types";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import {
  resolveSelectedSkills,
  normalizeSkillIds,
} from "../../skills/selection";
import { runTurnPreflights } from "./turn-preflight";
import {
  buildChatImageStorageKey,
  downloadChatImageObject,
  getContentStorageBucketName,
  uploadChatImageObject,
} from "../../sources/storage";
import {
  buildEffectiveToolsSelection,
  buildRuntimeTools,
  buildTurnOptionsSnapshot,
  readSkillRuntimeConfig,
  resolveTurnToolSelections,
  resolveWebSearchEnabled,
} from "./tool-selection";
import type {
  AgentMultimodalContentPart,
  ChatInputImage,
  ChatMessageImagePart,
  MessageContentJson,
  PreflightBillingTrace,
  ThinkingStepTrace,
  ThreadToolsSelection,
  TraceContinuationMetadata,
} from "./types";
import { normalizeTraceParts } from "./trace-parts";
import {
  listCapabilityTools,
  resolveCapabilitySkillRuntimeWorkflow,
} from "./capability-command-workflows";
import { resolveSelectedSkillRuntimeContract } from "./active-skill-runtime";
import { normalizeInvokedSkillIds } from "./invoked-skills";

const CHAT_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const MAX_CHAT_IMAGE_COUNT = 8;

const MAX_CHAT_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
const CHAT_VISION_FALLBACK_OPERATION = "chat.vision_fallback";
const VISION_FALLBACK_DESCRIPTION_OPERATION = "vision.describe";
const VISION_FALLBACK_IDEMPOTENCY_PREFIX = "vision-fallback";
const PREFLIGHT_VISION_CAPABILITY_SEQUENCE = -2;
const PREFLIGHT_VISION_FALLBACK_SEQUENCE = -1;

const THREAD_MODEL_KINDS = Object.keys(
  MODEL_KIND_BY_THREAD_KIND,
) as readonly ThreadModelKind[];

/**
 * Model kinds a single request may override the profile of. Listed by model
 * kind rather than by capability: the request carries one image override and
 * one vision override no matter how many tools consume them.
 */
const REQUESTABLE_THREAD_MODEL_KINDS = ["image", "vision"] as const;
type RequestableThreadModelKind =
  (typeof REQUESTABLE_THREAD_MODEL_KINDS)[number];

function resolveInvocationSkillId(input: {
  enabledSkills: readonly EnabledSkillDescriptor[];
  invocation: ReturnType<typeof resolveThreadInvocation>;
}) {
  const sourceRef = input.invocation?.sourceRef;
  if (sourceRef?.kind !== "skill_command") {
    return undefined;
  }
  return input.enabledSkills.find((skill) => skill.name === sourceRef.skillSlug)
    ?.workspaceSkillId;
}

async function resolveExistingOverrideUserMessage(input: {
  createdBy: string;
  messageId?: string;
  teamId: string;
  threadId: string;
  workspaceId: string;
}) {
  if (!input.messageId) {
    return null;
  }
  const existing = await findMessageRecord({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    messageId: input.messageId,
  });
  if (!existing) {
    return null;
  }
  if (
    existing.threadId !== input.threadId ||
    existing.role !== "user" ||
    existing.createdBy !== input.createdBy
  ) {
    throw new ContentError(
      409,
      "MESSAGE_ID_OVERRIDE_CONFLICT",
      "Message id override is already used by another message.",
    );
  }
  return existing;
}

function mergeSkillRuntimeConfig(input: {
  enabledSkills: readonly EnabledSkillDescriptor[];
  tools: StreamThreadEventInput["tools"];
}): EnabledSkillDescriptor[] {
  const runtimeConfig = readSkillRuntimeConfig(input.tools);
  if (Object.keys(runtimeConfig).length === 0) {
    return [...input.enabledSkills];
  }
  return input.enabledSkills.map((skill) => {
    const config =
      runtimeConfig[skill.workspaceSkillId] ??
      runtimeConfig[skill.selectionId ?? ""];
    if (!config) {
      return skill;
    }
    const defaultConfig =
      skill.defaultConfig && typeof skill.defaultConfig === "object"
        ? skill.defaultConfig
        : {};
    const currentConfig =
      defaultConfig.config &&
      typeof defaultConfig.config === "object" &&
      !Array.isArray(defaultConfig.config)
        ? (defaultConfig.config as Record<string, unknown>)
        : {};
    return {
      ...skill,
      defaultConfig: {
        ...defaultConfig,
        config: {
          ...currentConfig,
          ...config,
        },
      },
    };
  });
}

type VisionFallbackBillingItem = {
  imageId: string;
  imageFileName: string;
  gatewayConfigId: string;
  profileAlias: string;
  modelAlias: string;
  usage?: UsageInfo;
  provider?: string | null;
  providerModel?: string | null;
  routeDecision?: RouteDecision;
  /**
   * Ledger metadata known before the describe call is issued. The provider /
   * route fields above are only known afterwards, so they are folded in when
   * the preflight trace is assembled rather than sent to the meter.
   */
  billingMetadata: Record<string, unknown>;
  /**
   * The billed gateway settles each describe call as it completes. The trace is
   * carried here and mapped into a `PreflightBillingTrace` later in the turn,
   * which keeps the two-phase shape the turn outcome depends on.
   */
  meteredCall: MeteredModelCallTrace | null;
};

type VisionFallbackResult = {
  agentMessageContent: string;
  imageParts: ChatMessageImagePart[];
  billingItems: VisionFallbackBillingItem[];
  preflightBilling: PreflightBillingTrace[];
  steps: ThinkingStepTrace[];
};

function getObjectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getTraceSequence(value: unknown) {
  const sequence = getObjectRecord(value)?.sequence;
  return typeof sequence === "number" && Number.isFinite(sequence)
    ? sequence
    : null;
}

function resolveTraceContinuationMetadata(
  assistantMessage: MessageRecord | null,
): TraceContinuationMetadata | null {
  if (!assistantMessage) {
    return null;
  }

  const metadata = assistantMessage.metadata;
  const traceParts = normalizeTraceParts(metadata.traceParts);
  const traceGroups = [
    ...(Array.isArray(metadata.traceEvents) ? metadata.traceEvents : []),
    ...(Array.isArray(metadata.reasoningSegments)
      ? metadata.reasoningSegments
      : []),
    ...(Array.isArray(metadata.thinkingSteps) ? metadata.thinkingSteps : []),
    ...(Array.isArray(metadata.toolCalls) ? metadata.toolCalls : []),
  ];
  let maxSequence = 0;
  for (const item of traceGroups) {
    const sequence = getTraceSequence(item);
    if (sequence !== null) {
      maxSequence = Math.max(maxSequence, sequence);
    }
  }
  for (const part of traceParts) {
    const partSequence = getTraceSequence(part);
    if (partSequence !== null) {
      maxSequence = Math.max(maxSequence, partSequence);
    }
  }

  const toolSequenceById: Record<string, number> = {};
  if (Array.isArray(metadata.toolCalls)) {
    for (const toolCall of metadata.toolCalls) {
      const record = getObjectRecord(toolCall);
      const id = record?.id;
      const sequence = getTraceSequence(record);
      if (typeof id === "string" && id.length > 0 && sequence !== null) {
        toolSequenceById[id] = sequence;
      }
    }
  }

  return maxSequence > 0 ||
    Object.keys(toolSequenceById).length > 0 ||
    traceParts.length > 0
    ? {
        maxSequence,
        toolSequenceById,
        traceParts,
      }
    : null;
}

function chatProfileSupportsImageInput(input: {
  chatProfile: Awaited<ReturnType<typeof resolveActiveChatProfileByAlias>>;
}) {
  const configJson =
    input.chatProfile.configJson &&
    typeof input.chatProfile.configJson === "object"
      ? (input.chatProfile.configJson as Record<string, unknown>)
      : {};
  return configJson.supportsImageInput === true;
}

function buildMessageImageUrl(input: {
  workspaceId: string;
  messageId: string;
  imageId: string;
}) {
  return `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/messages/${encodeURIComponent(input.messageId)}/images/${encodeURIComponent(input.imageId)}/file`;
}

function dataUrlToImageBuffer(input: ChatInputImage) {
  const match = input.dataUrl.match(
    /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.*)$/i,
  );
  if (!match) {
    throw new ContentError(
      400,
      "CHAT_IMAGE_INVALID_DATA_URL",
      "Image attachments must be base64 data URLs",
    );
  }

  const mimeType =
    match[1]?.toLowerCase() === "image/jpg"
      ? "image/jpeg"
      : (match[1]?.toLowerCase() ?? "");
  if (!CHAT_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new ContentError(
      400,
      "CHAT_IMAGE_UNSUPPORTED_TYPE",
      "Only PNG, JPEG, WebP, and GIF images are supported",
    );
  }

  const body = Buffer.from(match[2] ?? "", "base64");
  if (body.length === 0) {
    throw new ContentError(
      400,
      "CHAT_IMAGE_EMPTY",
      "Image attachment is empty",
    );
  }
  if (body.length > MAX_CHAT_IMAGE_SIZE_BYTES) {
    throw new ContentError(
      400,
      "CHAT_IMAGE_TOO_LARGE",
      "Images must be 10MB or smaller",
    );
  }

  return { body, mimeType };
}

async function readImageDimensions(
  body: Buffer,
  fallback?: { width?: number; height?: number },
) {
  try {
    const metadata = await sharp(body, { animated: false }).metadata();
    return {
      width: metadata.width ?? fallback?.width ?? null,
      height: metadata.height ?? fallback?.height ?? null,
    };
  } catch {
    return {
      width: fallback?.width ?? null,
      height: fallback?.height ?? null,
    };
  }
}

function sanitizeImageFileName(value: string | undefined, index: number) {
  const fallback = `image-${index + 1}`;
  const trimmed = value?.trim() || fallback;
  return trimmed.slice(0, 255);
}

async function saveChatInputImages(input: {
  workspaceId: string;
  messageId: string;
  images?: ChatInputImage[];
}): Promise<Array<{ part: ChatMessageImagePart; dataUrl: string }>> {
  const images = (input.images ?? []).slice(0, MAX_CHAT_IMAGE_COUNT);
  const bucket = getContentStorageBucketName();
  const saved: Array<{ part: ChatMessageImagePart; dataUrl: string }> = [];

  for (const [index, image] of images.entries()) {
    const { body, mimeType } = dataUrlToImageBuffer(image);
    const imageId = randomUUID();
    const fileName = sanitizeImageFileName(image.fileName, index);
    const dimensions = await readImageDimensions(body, {
      width: image.width,
      height: image.height,
    });
    const storageKey = buildChatImageStorageKey({
      workspaceId: input.workspaceId,
      messageId: input.messageId,
      imageId,
      fileName,
    });

    await uploadChatImageObject({
      key: storageKey,
      body,
      contentType: mimeType,
    });

    saved.push({
      dataUrl: `data:${mimeType};base64,${body.toString("base64")}`,
      part: {
        type: "image",
        id: imageId,
        fileName,
        mimeType,
        sizeBytes: image.sizeBytes ?? body.length,
        width: dimensions.width,
        height: dimensions.height,
        storageBucket: bucket,
        storageKey,
        url: buildMessageImageUrl({
          workspaceId: input.workspaceId,
          messageId: input.messageId,
          imageId,
        }),
      },
    });
  }

  return saved;
}

function buildMessageContentJson(input: {
  text: string;
  images: ChatMessageImagePart[];
}): MessageContentJson {
  return {
    version: 1,
    parts: [
      ...(input.text.trim().length > 0
        ? [{ type: "text" as const, text: input.text }]
        : []),
      ...input.images,
    ],
  };
}

function extractImagePartsFromContentJson(value: unknown) {
  const contentJson =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { parts?: unknown })
      : {};
  if (!Array.isArray(contentJson.parts)) {
    return [] as ChatMessageImagePart[];
  }

  return contentJson.parts
    .map((part): ChatMessageImagePart | null => {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        return null;
      }
      const record = part as Record<string, unknown>;
      if (
        record.type !== "image" ||
        typeof record.id !== "string" ||
        typeof record.fileName !== "string" ||
        typeof record.mimeType !== "string" ||
        typeof record.storageKey !== "string" ||
        typeof record.url !== "string"
      ) {
        return null;
      }
      return {
        type: "image" as const,
        id: record.id,
        fileName: record.fileName,
        mimeType: record.mimeType,
        sizeBytes:
          typeof record.sizeBytes === "number" &&
          Number.isFinite(record.sizeBytes)
            ? record.sizeBytes
            : 0,
        width:
          typeof record.width === "number" && Number.isFinite(record.width)
            ? record.width
            : null,
        height:
          typeof record.height === "number" && Number.isFinite(record.height)
            ? record.height
            : null,
        storageBucket:
          typeof record.storageBucket === "string"
            ? record.storageBucket
            : null,
        storageKey: record.storageKey,
        url: record.url,
        ...(typeof record.visionDescription === "string"
          ? { visionDescription: record.visionDescription }
          : {}),
        ...(typeof record.visionModelAlias === "string"
          ? { visionModelAlias: record.visionModelAlias }
          : {}),
        ...(typeof record.visionProfileAlias === "string"
          ? { visionProfileAlias: record.visionProfileAlias }
          : {}),
      };
    })
    .filter((part): part is ChatMessageImagePart => part !== null);
}

function shouldRejectEmptyThreadMessage(input: {
  messageContent: string;
  images?: ChatInputImage[];
  existingUserMessageContentJson?: unknown;
  existingImageParts?: ChatMessageImagePart[];
}) {
  const hasInputImages = (input.images?.length ?? 0) > 0;
  const hasExistingImages =
    extractImagePartsFromContentJson(input.existingUserMessageContentJson)
      .length > 0 || (input.existingImageParts?.length ?? 0) > 0;
  return !input.messageContent && !hasInputImages && !hasExistingImages;
}

function cloneImagePartsForMessage(input: {
  workspaceId: string;
  messageId: string;
  parts: ChatMessageImagePart[];
}) {
  return input.parts.map((part) => ({
    ...part,
    url: buildMessageImageUrl({
      workspaceId: input.workspaceId,
      messageId: input.messageId,
      imageId: part.id,
    }),
  }));
}

async function hydrateImageParts(
  parts: ChatMessageImagePart[],
): Promise<Array<{ part: ChatMessageImagePart; dataUrl: string }>> {
  const images: Array<{ part: ChatMessageImagePart; dataUrl: string }> = [];
  for (const part of parts.slice(0, MAX_CHAT_IMAGE_COUNT)) {
    const body = await downloadChatImageObject({
      bucket: part.storageBucket,
      key: part.storageKey,
    });
    images.push({
      part,
      dataUrl: `data:${part.mimeType};base64,${body.toString("base64")}`,
    });
  }
  return images;
}

async function buildDirectMultimodalContent(input: {
  text: string;
  images: Array<{ part: ChatMessageImagePart; dataUrl: string }>;
}): Promise<AgentMultimodalContentPart[]> {
  const parts: AgentMultimodalContentPart[] = [
    {
      type: "text",
      text: input.text.trim() || "Please answer using the attached image(s).",
    },
  ];
  for (const image of input.images) {
    parts.push({
      type: "image_url",
      image_url: {
        url: image.dataUrl,
      },
    });
  }
  return parts;
}

function buildVisionFallbackText(input: {
  text: string;
  descriptions: Array<{ fileName: string; description: string }>;
}) {
  return [
    input.text.trim(),
    "",
    `The user attached ${input.descriptions.length} image(s). Vision descriptions generated for this turn:`,
    ...input.descriptions.map(
      (description, index) =>
        `[image ${index + 1}: ${description.fileName}]\n${description.description}`,
    ),
  ]
    .filter((line, index) => index !== 0 || line.length > 0)
    .join("\n")
    .trim();
}

function buildVisionFallbackDescriptionPrompt(text: string) {
  return (
    "Describe the attached image only with details relevant to answering the user's question. Do not run a separate OCR pass. Mention visible text only when it is relevant to the question.\n\n" +
    `User question:\n${text.trim() || "No text question was provided."}`
  );
}

/**
 * Pinned billing identity for one described image.
 *
 * Both strings are load-bearing: they address rows that may already exist in
 * the ledger. Changing either one re-meters an already-charged reference and
 * bills every affected user a second time, so they are built here, in one
 * place, and must never be reworded.
 */
function buildVisionFallbackIdempotencyKey(input: {
  userMessageId: string;
  imageId: string;
}) {
  return `${VISION_FALLBACK_IDEMPOTENCY_PREFIX}:${input.userMessageId}:${input.imageId}`;
}

function buildVisionFallbackReferenceId(input: {
  threadId: string;
  userMessageId: string;
  imageId: string;
}) {
  return `thread:${input.threadId}:message:${input.userMessageId}:image:${input.imageId}:vision-fallback`;
}

function createVisionCapabilityStep(input: {
  chatModelAlias: string;
  imageCount: number;
  sequence: number;
  supported: boolean;
}): ThinkingStepTrace {
  return {
    id: "vision-capability-check",
    kind: "state",
    title: input.supported
      ? "Using chat model vision input"
      : "Checking chat model vision support",
    status: "completed",
    items: [`${input.imageCount} image(s)`],
    sequence: input.sequence,
    description: input.supported
      ? `${input.chatModelAlias} accepts image input directly.`
      : `${input.chatModelAlias} does not advertise image input support.`,
    metadata: {
      imageCount: input.imageCount,
      modelAlias: input.chatModelAlias,
      supportsImageInput: input.supported,
    },
  };
}

function createVisionFallbackStartStep(input: {
  chatModelAlias: string;
  imageCount: number;
  sequence: number;
  visionModelAlias: string;
  visionProfileAlias: string;
}): ThinkingStepTrace {
  return {
    id: "vision-fallback-describe",
    kind: "state",
    title: "Preparing image descriptions with vision model",
    status: "in_progress",
    items: [`${input.imageCount} image(s)`],
    sequence: input.sequence,
    description: `${input.chatModelAlias} will receive text descriptions from ${input.visionModelAlias}.`,
    metadata: {
      chatModelAlias: input.chatModelAlias,
      imageCount: input.imageCount,
      strategy: "vision_fallback",
      visionModelAlias: input.visionModelAlias,
      visionProfileAlias: input.visionProfileAlias,
    },
  };
}

function createVisionFallbackCompleteStep(input: {
  chatModelAlias: string;
  images: Array<{
    description: string;
    fileName: string;
    imageId: string;
    mimeType: string;
    url: string;
  }>;
  sequence: number;
  visionModelAlias: string;
  visionProfileAlias: string;
}): ThinkingStepTrace {
  return {
    id: "vision-fallback-describe",
    kind: "state",
    title: "Prepared image descriptions with vision model",
    status: "completed",
    items: input.images.map((image) => image.fileName),
    sequence: input.sequence,
    description: `${input.visionModelAlias} described the image(s); ${input.chatModelAlias} will answer from those descriptions.`,
    metadata: {
      chatModelAlias: input.chatModelAlias,
      imageCount: input.images.length,
      images: input.images,
      strategy: "vision_fallback",
      visionModelAlias: input.visionModelAlias,
      visionProfileAlias: input.visionProfileAlias,
    },
  };
}

function buildExistingVisionFallback(input: {
  chatModelAlias: string;
  text: string;
  images: Array<{ part: ChatMessageImagePart; dataUrl: string }>;
}): VisionFallbackResult | null {
  const descriptions = input.images
    .map((image) =>
      image.part.visionDescription
        ? {
            fileName: image.part.fileName,
            description: image.part.visionDescription,
          }
        : null,
    )
    .filter((item): item is { fileName: string; description: string } =>
      Boolean(item),
    );

  if (descriptions.length !== input.images.length) {
    return null;
  }

  return {
    agentMessageContent: buildVisionFallbackText({
      text: input.text,
      descriptions,
    }),
    imageParts: input.images.map((image) => image.part),
    billingItems: [] as VisionFallbackBillingItem[],
    preflightBilling: [] as PreflightBillingTrace[],
    steps: [
      createVisionFallbackCompleteStep({
        chatModelAlias: input.chatModelAlias,
        images: input.images.map((image) => ({
          description: image.part.visionDescription ?? "",
          fileName: image.part.fileName,
          imageId: image.part.id,
          mimeType: image.part.mimeType,
          url: image.part.url,
        })),
        sequence: PREFLIGHT_VISION_FALLBACK_SEQUENCE,
        visionModelAlias: input.images[0]?.part.visionModelAlias ?? "vision",
        visionProfileAlias:
          input.images[0]?.part.visionProfileAlias ?? "vision",
      }),
    ],
  };
}

async function runVisionFallbackDescription(input: {
  gateway: BilledModelGateway;
  modelAlias: string;
  execution?: LlmExecutionConfig;
  prompt: string;
  dataUrl: string;
  options: BilledRequestOptions;
}): Promise<ChatCompleteResult> {
  return input.gateway.chat.complete(
    {
      model: input.modelAlias,
      ...(input.execution ? input.execution : {}),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: input.prompt,
            },
            {
              type: "image_url",
              image_url: {
                url: input.dataUrl,
              },
            },
          ],
        },
      ],
    },
    input.options,
  );
}

async function buildVisionFallback(input: {
  chatModelAlias: string;
  workspace: Awaited<ReturnType<typeof requireContentWorkspace>>;
  billing: ContentBillingPort;
  threadId: string;
  userId: string;
  userMessageId: string;
  traceId: string;
  text: string;
  images: Array<{ part: ChatMessageImagePart; dataUrl: string }>;
  onThinkingStep?: (step: ThinkingStepTrace) => void;
  requestedVisionProfileAlias?: string | null;
  threadVisionProfileAlias?: string | null;
  visionExecution?: LlmExecutionConfig;
  /** Injected for tests so metering can be driven without a database. */
  meterUsage?: MeterUsageFn;
}): Promise<VisionFallbackResult> {
  let visionProfile;
  const shouldUseDefaultVisionProfile =
    input.requestedVisionProfileAlias === null ||
    (!input.requestedVisionProfileAlias && !input.threadVisionProfileAlias);
  try {
    visionProfile = await resolveModelGatewayProfile({
      kind: "vision",
      requestedProfileAlias:
        input.requestedVisionProfileAlias === null
          ? undefined
          : input.requestedVisionProfileAlias || input.threadVisionProfileAlias,
      defaultRequired: shouldUseDefaultVisionProfile,
    });
    if (
      !visionProfile &&
      (input.requestedVisionProfileAlias || input.threadVisionProfileAlias)
    ) {
      visionProfile = await resolveModelGatewayProfile({
        kind: "vision",
        defaultRequired: true,
      });
    }
  } catch (error) {
    throw new ContentError(
      400,
      "VISION_MODEL_REQUIRED",
      error instanceof Error
        ? error.message
        : "Choose an image-capable chat model or configure a vision model",
    );
  }
  if (!visionProfile) {
    throw new ContentError(
      400,
      "VISION_MODEL_REQUIRED",
      "Choose an image-capable chat model or configure a vision model",
    );
  }

  // The describe pass genuinely charges the customer, so it opens a billed
  // scope rather than a raw client. Settlement happens per call inside the
  // wrapper; the resulting traces are carried forward and turned into
  // PreflightBillingTrace values once the turn's trace id is known.
  // 谁问谁付: a guest's describe pass bills the guest's own personal org, not
  // the host team. Members bill the workspace's org, unchanged.
  const billingTeamId = await workspaceService.resolveBillingOrganizationId({
    workspaceId: input.workspace.id,
    userId: input.userId,
    workspaceOrganizationId: input.workspace.organizationId,
  });

  const { gateway, scope } = await openBilledModelGateway({
    billing: input.billing,
    gatewayConfigId: visionProfile.gatewayConfigId,
    meterUsage: input.meterUsage,
    context: {
      teamId: billingTeamId,
      workspaceId: input.workspace.id,
      actorUserId: input.userId,
      feature: "chat",
      intent: { mode: "billed" },
      scopeKind: "thread-turn",
      scopeId: input.traceId,
      threadId: input.threadId,
      messageId: input.userMessageId,
    },
  });
  const descriptions: Array<{
    imageId: string;
    fileName: string;
    description: string;
  }> = [];
  const billingItems: VisionFallbackBillingItem[] = [];
  const startStep = createVisionFallbackStartStep({
    chatModelAlias: input.chatModelAlias,
    imageCount: input.images.length,
    sequence: PREFLIGHT_VISION_FALLBACK_SEQUENCE,
    visionModelAlias: visionProfile.modelAlias,
    visionProfileAlias: visionProfile.profileAlias,
  });
  const steps: ThinkingStepTrace[] = [startStep];
  input.onThinkingStep?.(startStep);

  for (const image of input.images) {
    const billingMetadata = {
      traceId: input.traceId,
      threadId: input.threadId,
      messageId: input.userMessageId,
      imageId: image.part.id,
      imageFileName: image.part.fileName,
      chatModelAlias: input.chatModelAlias,
    };
    // settle() appends at most one trace per call, so the tail beyond this
    // mark is this image's trace.
    const meteredBefore = scope.meteredCalls().length;
    const result = await runVisionFallbackDescription({
      gateway,
      modelAlias: visionProfile.modelAlias,
      execution: input.visionExecution,
      prompt: buildVisionFallbackDescriptionPrompt(input.text),
      dataUrl: image.dataUrl,
      options: {
        traceId: input.userMessageId,
        operation: CHAT_VISION_FALLBACK_OPERATION,
        modelKind: "vision",
        profileAlias: visionProfile.profileAlias,
        modelAlias: visionProfile.modelAlias,
        gatewayConfigId: visionProfile.gatewayConfigId,
        idempotencyKey: buildVisionFallbackIdempotencyKey({
          userMessageId: input.userMessageId,
          imageId: image.part.id,
        }),
        referenceId: buildVisionFallbackReferenceId({
          threadId: input.threadId,
          userMessageId: input.userMessageId,
          imageId: image.part.id,
        }),
        billingMetadata,
      },
    });
    const description =
      typeof result.raw.content === "string"
        ? result.raw.content
        : String(result.raw.content ?? "");
    descriptions.push({
      imageId: image.part.id,
      fileName: image.part.fileName,
      description: description.trim(),
    });
    billingItems.push({
      imageId: image.part.id,
      imageFileName: image.part.fileName,
      gatewayConfigId: visionProfile.gatewayConfigId,
      profileAlias: visionProfile.profileAlias,
      modelAlias: visionProfile.modelAlias,
      usage: result.usage,
      provider: result.provider ?? null,
      providerModel: result.providerModel ?? null,
      ...(result.routeDecision ? { routeDecision: result.routeDecision } : {}),
      billingMetadata,
      meteredCall: scope.meteredCalls()[meteredBefore] ?? null,
    });
  }

  const completedStep = createVisionFallbackCompleteStep({
    chatModelAlias: input.chatModelAlias,
    images: input.images.map((image) => {
      const description = descriptions.find(
        (item) => item.imageId === image.part.id,
      );
      return {
        description: description?.description ?? "",
        fileName: image.part.fileName,
        imageId: image.part.id,
        mimeType: image.part.mimeType,
        url: image.part.url,
      };
    }),
    sequence: PREFLIGHT_VISION_FALLBACK_SEQUENCE,
    visionModelAlias: visionProfile.modelAlias,
    visionProfileAlias: visionProfile.profileAlias,
  });
  steps[0] = completedStep;
  input.onThinkingStep?.(completedStep);

  const fallbackText = buildVisionFallbackText({
    text: input.text,
    descriptions,
  });

  return {
    agentMessageContent: fallbackText,
    imageParts: input.images.map((image) => {
      const description = descriptions.find(
        (item) => item.imageId === image.part.id,
      );
      return {
        ...image.part,
        ...(description?.description
          ? { visionDescription: description.description }
          : {}),
        visionModelAlias: visionProfile.modelAlias,
        visionProfileAlias: visionProfile.profileAlias,
      };
    }),
    billingItems,
    preflightBilling: [] as PreflightBillingTrace[],
    steps,
  };
}

/**
 * Second phase of the vision fallback's billing: turns the traces the billed
 * gateway settled during the describe pass into the turn's
 * `PreflightBillingTrace` list.
 *
 * The two phases stay separate because the provider and route the gateway
 * actually chose are only known once each describe call has returned, and the
 * turn outcome and preflight thinking steps read this shape.
 */
function buildVisionFallbackPreflightBilling(input: {
  items: VisionFallbackBillingItem[];
}): PreflightBillingTrace[] {
  const traces: PreflightBillingTrace[] = [];
  for (const item of input.items) {
    const metered = item.meteredCall;
    if (!metered) {
      continue;
    }

    traces.push({
      id: item.imageId,
      operation: CHAT_VISION_FALLBACK_OPERATION,
      modelKind: "vision",
      modelAlias: item.modelAlias,
      profileAlias: item.profileAlias,
      consumedCredits: metered.consumedCredits,
      billedBy: metered.billedBy ?? "skipped",
      skipReason: metered.skipReason ?? null,
      usage: item.usage,
      metadata: {
        ...item.billingMetadata,
        provider: item.provider ?? null,
        providerModel: item.providerModel ?? null,
        routeDecision: item.routeDecision ?? null,
        idempotencyReplayed: metered.billing?.idempotencyReplayed ?? false,
        providerCostUsd: metered.providerCostUsd,
        pricingSnapshot: metered.pricingSnapshot,
      },
    });
  }

  return traces;
}

export const testExports = {
  CHAT_VISION_FALLBACK_OPERATION,
  PREFLIGHT_VISION_CAPABILITY_SEQUENCE,
  PREFLIGHT_VISION_FALLBACK_SEQUENCE,
  VISION_FALLBACK_DESCRIPTION_OPERATION,
  buildThreadCommandMetadata,
  buildVisionFallbackDescriptionPrompt,
  buildVisionFallbackIdempotencyKey,
  buildVisionFallbackPreflightBilling,
  buildVisionFallbackReferenceId,
  buildCommandAugmentedText,
  buildInvocationAugmentedText,
  parsePromptMarkers,
  parseRequestedCommand,
  resolveLatestAssistantFinalCheckpoint,
  resolveLatestSourceIds,
  resolveTraceContinuationMetadata,
  resolveThreadCommand,
  resolveThreadInvocation,
  resolveToolCommandName,
  shouldRejectEmptyThreadMessage,
  buildTurnInvocationRegistry,
};

function normalizeSupportedParameters(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
const DEFAULT_TIMEZONE = "UTC";

function normalizeSupportedEfforts(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as Array<(typeof REASONING_EFFORTS)[number]>;
  }

  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter((item): item is (typeof REASONING_EFFORTS)[number] =>
          REASONING_EFFORTS.includes(
            item as (typeof REASONING_EFFORTS)[number],
          ),
        ),
    ),
  );
}

function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeTimezone(value: unknown) {
  if (typeof value !== "string") {
    return DEFAULT_TIMEZONE;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100) {
    return DEFAULT_TIMEZONE;
  }

  return isValidTimeZone(trimmed) ? trimmed : DEFAULT_TIMEZONE;
}

async function resolvePreparedByokExecution(input: {
  workspaceId: string;
  userId: string;
  llm: LlmExecutionConfig;
  expectedModelType: "llm" | "image" | "vision";
}): Promise<LlmExecutionConfig> {
  if (input.llm.byokModelId) {
    const resolved = await contentByokService.resolveByokModelExecution({
      workspaceId: input.workspaceId,
      userId: input.userId,
      byokModelId: input.llm.byokModelId,
    });
    if (resolved.modelType !== input.expectedModelType) {
      throw new ContentError(
        400,
        "BYOK_MODEL_TYPE_MISMATCH",
        `BYOK ${input.expectedModelType} execution requires a ${input.expectedModelType} model`,
      );
    }
    return {
      ...input.llm,
      profileAlias: undefined,
      modelAlias: resolved.displayName,
      providerModel: resolved.modelName,
      providerHint: resolved.providerName,
      byokModelId: resolved.byokModelId,
      credentialId: resolved.credentialId,
      byok: {
        provider: resolved.providerName,
        providerKind: resolved.providerKind,
        ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
        apiKey: resolved.apiKey,
        defaultHeaders: resolved.defaultHeaders,
      },
      ...(input.llm.thinking
        ? {
            thinking: {
              ...input.llm.thinking,
            },
          }
        : {}),
    };
  }

  throw new ContentError(
    400,
    "BYOK_MODEL_REQUIRED",
    "BYOK execution requires a saved BYOK model",
  );
}

async function resolvePreparedLlmConfig(input: {
  workspaceId: string;
  userId: string;
  chatProfile: Awaited<ReturnType<typeof resolveActiveChatProfileByAlias>>;
  llm?: LlmExecutionConfig;
}): Promise<LlmExecutionConfig | undefined> {
  if (input.llm?.executionMode === "BYOK") {
    return resolvePreparedByokExecution({
      workspaceId: input.workspaceId,
      userId: input.userId,
      llm: input.llm,
      expectedModelType: "llm",
    });
  }

  const configJson =
    input.chatProfile.configJson &&
    typeof input.chatProfile.configJson === "object"
      ? (input.chatProfile.configJson as Record<string, unknown>)
      : {};
  const supportedParameters = input.llm?.thinking
    ? normalizeSupportedParameters(configJson.supportedParameters)
    : undefined;
  const supportedEfforts = input.llm?.thinking
    ? normalizeSupportedEfforts(configJson.supportedEfforts)
    : undefined;

  return {
    ...input.llm,
    profileAlias: input.llm?.profileAlias ?? input.chatProfile.profileAlias,
    modelAlias: input.llm?.modelAlias ?? input.chatProfile.modelAlias,
    providerModel: input.llm?.providerModel ?? input.chatProfile.modelAlias,
    ...(input.llm?.thinking
      ? {
          thinking: {
            ...input.llm.thinking,
            supportedParameters,
            supportedEfforts,
          },
        }
      : {}),
  };
}

export async function prepareThreadTurn(
  input: StreamThreadEventInput,
  dependencies: {
    billing?: ContentBillingPort;
    invocationRegistry?: SelectableInvocationRegistry;
    /** Test seams for the vision fallback's billing; production uses defaults. */
    meterUsage?: MeterUsageFn;
  } = {},
): Promise<PreparedThreadTurn> {
  const displayMessageContent =
    input.existingUserMessage?.content.trim() ?? input.content.trim();
  const parsedPrompt = parsePromptMarkers(displayMessageContent);
  const messageContent = parsedPrompt.cleanContent;
  if (
    shouldRejectEmptyThreadMessage({
      messageContent: displayMessageContent,
      images: input.images,
      existingUserMessageContentJson: input.existingUserMessage?.contentJson,
      existingImageParts: input.existingImageParts,
    })
  ) {
    throw new ContentError(
      400,
      "EMPTY_MESSAGE",
      "content or images is required for thread stream",
    );
  }

  const workspace = await requireContentWorkspace({
    workspaceId: input.workspaceId,
    userId: input.userId,
  });

  let thread = await findThreadRecord({
    threadId: input.threadId,
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
  });

  if (!thread) {
    throw new ContentError(404, "THREAD_NOT_FOUND", "Thread not found");
  }

  const originalThreadSettings = normalizeThreadModelSettings(
    thread.modelSettings,
  );
  const persistedThreadSettings = await pruneUnavailableThreadModelAliases(
    originalThreadSettings,
  );
  const requestedProfileAlias =
    typeof input.llm?.profileAlias === "string"
      ? input.llm.profileAlias.trim()
      : "";
  const requestedModelAlias =
    typeof input.llm?.modelAlias === "string"
      ? input.llm.modelAlias.trim()
      : "";
  const requestedExecutionMode = input.llm?.executionMode;

  const resolvedChatModel = await resolveThreadChatProfile({
    threadModelSettings: persistedThreadSettings,
    requestedProfileAlias:
      requestedExecutionMode === "BYOK"
        ? undefined
        : requestedProfileAlias || undefined,
    requestedModelAlias:
      requestedExecutionMode === "BYOK"
        ? undefined
        : requestedProfileAlias
          ? undefined
          : requestedModelAlias || undefined,
  });

  const markerMentionedSourceIds = dedupeSourceIds(
    markerSourceIds(parsedPrompt.markers),
  );
  const markerSourceTitleIds = await resolveSourceIdsByTitles({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    titles: markerSourceTitles(parsedPrompt.markers),
  });
  const mentionedSourceIds = dedupeSourceIds([
    ...markerMentionedSourceIds,
    ...markerSourceTitleIds,
    ...(input.mentionedSourceIds ?? []),
  ]);
  const mentionedSourceScope = await resolveSourceTreeScope({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    selectedSourceIds: mentionedSourceIds,
  });
  const effectiveMentionedSourceIds = mentionedSourceScope.effectiveSourceIds;
  const requestedSourceIds = dedupeSourceIds(input.sourceIds);
  const overrideUserMessage = await resolveExistingOverrideUserMessage({
    createdBy: input.userId,
    messageId: input.userMessageIdOverride,
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    threadId: thread.id,
  });
  const existingUserMessage = input.existingUserMessage ?? overrideUserMessage;
  const assistantMessageParentId = input.assistantMessageParentId ?? null;
  const messageRecords = await listMessageRecordsByThread({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    threadId: thread.id,
  });
  const contextMessageRecords = filterMessagesBeforeEditAnchor({
    anchorUserMessageId: input.contextAnchorUserMessageId,
    messages: messageRecords,
  });

  const fallbackSourceIds = resolveLatestSourceIds(contextMessageRecords);
  const selectedSourceIds =
    requestedSourceIds.length > 0 ? requestedSourceIds : fallbackSourceIds;
  const sourceScope = await resolveSourceTreeScope({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    selectedSourceIds,
  });
  const sourceIds = sourceScope.effectiveSourceIds;
  const markerToolCommand = lastToolCommandMarker(parsedPrompt.markers);
  const requestedCommand = parseRequestedCommand({
    command: markerToolCommand
      ? {
          arguments: messageContent,
          kind: "tool",
          name: markerToolCommand.value,
          toolName:
            resolveToolCommandName(markerToolCommand.value) ?? undefined,
        }
      : input.command,
  });
  const toolsWithMarkers = resolveMarkerToolSelection(
    parsedPrompt.markers,
    input.tools,
  );
  const selectedSkillIds = normalizeSkillIds(input.tools?.skillIds ?? []);
  const timezone = normalizeTimezone(input.timezone);
  let enabledSkills: EnabledSkillDescriptor[] = await resolveSelectedSkills({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    skillIds: selectedSkillIds,
  });
  enabledSkills = mergeSkillRuntimeConfig({
    enabledSkills,
    tools: toolsWithMarkers,
  });
  const resolvedCommand = await resolveThreadCommand({
    command: requestedCommand,
    enabledSkills,
  });
  const resolvedInvocation = resolveThreadInvocation({
    envelope: input.invocation,
    registry:
      dependencies.invocationRegistry ??
      (await buildDefaultTurnInvocationRegistry({
        enabledSkills,
      })),
    workspaceId: workspace.id,
    userId: input.userId,
  });
  const commandSkillId =
    resolvedCommand?.kind === "skill"
      ? enabledSkills.find(
          (skill) =>
            skill.name ===
            (resolvedCommand.skillSlug ??
              resolvedCommand.name.replace(/^\//, "")),
        )?.workspaceSkillId
      : undefined;
  const invocationSkillId = resolveInvocationSkillId({
    enabledSkills,
    invocation: resolvedInvocation,
  });
  const invokedSkillIds = Array.from(
    new Set([
      ...normalizeInvokedSkillIds({
        enabledSkills,
        requestedSkillIds: input.tools?.invokedSkillIds,
      }),
      ...(commandSkillId ? [commandSkillId] : []),
      ...(invocationSkillId ? [invocationSkillId] : []),
    ]),
  );
  const skillRuntimeWorkflows = new Map(
    (
      await Promise.all(
        enabledSkills.map(
          async (skill) =>
            [
              skill.name,
              await resolveCapabilitySkillRuntimeWorkflow(skill.name),
            ] as const,
        ),
      )
    ).filter(
      (entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] =>
        entry[1] !== null,
    ),
  );
  const selectedSkillRuntime = resolveSelectedSkillRuntimeContract({
    selectedSkills: enabledSkills,
    command: resolvedCommand,
    skillRuntimeWorkflows,
  });
  const toolsWithCommand = mergeCommandTools(toolsWithMarkers, resolvedCommand);
  const toolsWithSelectedSkillRuntime = mergeSelectedSkillRuntimeTools(
    toolsWithCommand,
    selectedSkillRuntime,
  );
  const toolsWithInvocation = mergeInvocationTools(
    toolsWithSelectedSkillRuntime,
    resolvedInvocation,
  );
  const toolsWithCapabilityDefaults = applyCapabilityToolOptionDefaults(
    toolsWithInvocation,
    await listCapabilityTools(),
  );
  // Every capability regularizes its own selection; the pipeline just collects
  // the results keyed by tool name.
  const turnToolSelections = resolveTurnToolSelections(
    toolsWithCapabilityDefaults,
  );
  const imageExecution =
    input.image?.executionMode === "BYOK"
      ? await resolvePreparedByokExecution({
          workspaceId: workspace.id,
          userId: input.userId,
          llm: input.image,
          expectedModelType: "image",
        })
      : input.image;
  const visionExecution =
    input.vision?.executionMode === "BYOK"
      ? await resolvePreparedByokExecution({
          workspaceId: workspace.id,
          userId: input.userId,
          llm: input.vision,
          expectedModelType: "vision",
        })
      : input.vision;

  await assertSourcesExist({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    sourceIds: Array.from(
      new Set([...selectedSourceIds, ...mentionedSourceIds]),
    ),
  });

  const requestedThreadProfiles = Object.fromEntries(
    REQUESTABLE_THREAD_MODEL_KINDS.map((kind) => [
      kind,
      resolveRequestedThreadProfileAlias({
        execution: input[kind],
        legacyProfileAlias: input[`${kind}ProfileAlias`],
        kind,
      }),
    ]),
  ) as Record<
    RequestableThreadModelKind,
    ReturnType<typeof resolveRequestedThreadProfileAlias>
  >;
  const persistedThreadSettingsWithSnapshots =
    await resolveThreadModelSettingsSnapshots(persistedThreadSettings);
  const normalizedThreadSettings = await pruneUnavailableThreadModelAliases(
    normalizeThreadModelSettings({
      ...persistedThreadSettingsWithSnapshots,
      ...Object.fromEntries(
        REQUESTABLE_THREAD_MODEL_KINDS.flatMap((kind) =>
          requestedThreadProfiles[kind].provided
            ? [
                [
                  `${kind}ProfileAlias`,
                  requestedThreadProfiles[kind].profileAlias,
                ],
              ]
            : [],
        ),
      ),
    }),
  );
  await validateThreadModelSettings(normalizedThreadSettings);
  const normalizedThreadSettingsWithSnapshots =
    await resolveThreadModelSettingsSnapshots(normalizedThreadSettings);

  // The turn's facts are settled; every capability that has async work of its
  // own now gets one shot at them. What comes back replaces its selection and
  // is otherwise opaque — the pipeline files it under the tool's name.
  const preflight = await runTurnPreflights({
    selections: turnToolSelections,
    command: resolvedCommand
      ? {
          kind: resolvedCommand.kind,
          ...(resolvedCommand.toolName
            ? { toolName: resolvedCommand.toolName }
            : {}),
        }
      : null,
    enabledSkills,
    executionByModelKind: {
      image: imageExecution,
      vision: visionExecution,
    },
    requestedProfileAliasByModelKind: Object.fromEntries(
      REQUESTABLE_THREAD_MODEL_KINDS.flatMap((kind) =>
        requestedThreadProfiles[kind].provided
          ? [[kind, requestedThreadProfiles[kind].profileAlias ?? null]]
          : [],
      ),
    ),
    threadProfileAliasByModelKind: Object.fromEntries(
      THREAD_MODEL_KINDS.map((threadKind) => [
        MODEL_KIND_BY_THREAD_KIND[threadKind],
        normalizedThreadSettingsWithSnapshots[`${threadKind}ProfileAlias`],
      ]),
    ),
  });

  const webAccessEnabled = resolveWebSearchEnabled({
    tools: toolsWithCapabilityDefaults,
    enabledSkills,
  });
  const toolOverrides: Record<string, unknown> = {
    ...turnToolSelections,
    ...preflight.selections,
  };
  const effectiveTools = buildEffectiveToolsSelection({
    baseTools: toolsWithCapabilityDefaults,
    skillIds: selectedSkillIds,
    ...(invokedSkillIds.length > 0 ? { invokedSkillIds } : {}),
    webAccessEnabled,
    ...(Object.keys(toolOverrides).length > 0 ? { toolOverrides } : {}),
  });
  const toolPermissions = resolveToolPermissions({
    command: resolvedCommand,
    selectedSkillRuntime,
    tools: effectiveTools,
  });
  const runtimeTools = buildRuntimeTools({
    toolPermissions,
    tools: effectiveTools,
  });
  const commandSuccessCriteria = resolvedCommand?.workflow?.successCriteria;
  const mcpTools = {};
  const profileAlias = resolvedChatModel.profileAlias;
  const modelAlias = resolvedChatModel.modelAlias;
  const chatProfile = await resolveActiveChatProfileByAlias(profileAlias);
  const llm = await resolvePreparedLlmConfig({
    workspaceId: workspace.id,
    userId: input.userId,
    chatProfile,
    llm: input.llm,
  });
  const providerModel =
    llm?.providerModel?.trim() ||
    (llm?.executionMode === "BYOK"
      ? llm?.modelAlias?.trim() || modelAlias
      : modelAlias);
  const userMessageId =
    existingUserMessage?.id ?? input.userMessageIdOverride ?? randomUUID();
  // Resolved here rather than after the user message is persisted because the
  // vision fallback bills against this trace id, and the fallback runs before
  // the message row exists. `userMessage.id` is `userMessageId` in both
  // branches, so the value is unchanged.
  const runTraceId = existingUserMessage
    ? `thread-run:${randomUUID()}`
    : userMessageId;
  const hasSubmittedImages = (input.images?.length ?? 0) > 0;
  const savedInputImages =
    existingUserMessage || !hasSubmittedImages
      ? []
      : await saveChatInputImages({
          workspaceId: workspace.id,
          messageId: userMessageId,
          images: input.images,
        });
  const existingImageParts =
    input.existingImageParts ??
    extractImagePartsFromContentJson(input.existingUserMessage?.contentJson);
  const savedImages =
    savedInputImages.length > 0
      ? savedInputImages
      : await hydrateImageParts(
          cloneImagePartsForMessage({
            workspaceId: workspace.id,
            messageId: userMessageId,
            parts: existingImageParts,
          }),
        );
  let imageParts = savedImages.map((image) => image.part);
  let preflightBilling: PreflightBillingTrace[] = [];
  let pendingVisionFallbackBilling: VisionFallbackBillingItem[] = [];
  const preflightThinkingSteps: ThinkingStepTrace[] = [];
  const agentText = buildInvocationAugmentedText({
    invocation: resolvedInvocation,
    text: buildCommandAugmentedText({
      command: resolvedCommand,
      text: messageContent,
    }),
  });
  let agentMessageContent: string | AgentMultimodalContentPart[] = agentText;
  if (savedImages.length > 0) {
    // Only explicit synced model capability enables direct multimodal input.
    if (chatProfileSupportsImageInput({ chatProfile })) {
      const step = createVisionCapabilityStep({
        chatModelAlias: modelAlias,
        imageCount: savedImages.length,
        sequence: PREFLIGHT_VISION_CAPABILITY_SEQUENCE,
        supported: true,
      });
      preflightThinkingSteps.push(step);
      input.onPreflightThinkingStep?.(step);
      agentMessageContent = await buildDirectMultimodalContent({
        text: agentText,
        images: savedImages,
      });
    } else {
      const step = createVisionCapabilityStep({
        chatModelAlias: modelAlias,
        imageCount: savedImages.length,
        sequence: PREFLIGHT_VISION_CAPABILITY_SEQUENCE,
        supported: false,
      });
      preflightThinkingSteps.push(step);
      input.onPreflightThinkingStep?.(step);
      const existingFallback = buildExistingVisionFallback({
        chatModelAlias: modelAlias,
        text: agentText,
        images: savedImages,
      });
      let visionFallback = existingFallback;
      if (!visionFallback) {
        // Describing images costs money, so this path needs a billing port.
        // Reusing an already-stored description does not.
        const visionBilling = dependencies.billing;
        if (!visionBilling) {
          throw new ContentError(
            500,
            "BILLING_UNAVAILABLE",
            "Billing is required to describe images with a vision model",
          );
        }
        visionFallback = await buildVisionFallback({
          chatModelAlias: modelAlias,
          workspace,
          billing: visionBilling,
          threadId: thread.id,
          userId: input.userId,
          userMessageId,
          traceId: runTraceId,
          meterUsage: dependencies.meterUsage,
          text: agentText,
          images: savedImages,
          onThinkingStep: input.onPreflightThinkingStep,
          requestedVisionProfileAlias: requestedThreadProfiles.vision.provided
            ? requestedThreadProfiles.vision.profileAlias
            : undefined,
          threadVisionProfileAlias: normalizedThreadSettings.visionProfileAlias,
          visionExecution,
        });
      }
      agentMessageContent = visionFallback.agentMessageContent;
      imageParts = visionFallback.imageParts;
      preflightBilling = visionFallback.preflightBilling ?? [];
      pendingVisionFallbackBilling = visionFallback.billingItems ?? [];
      preflightThinkingSteps.push(...visionFallback.steps);
    }
  }
  const baseMessageContentJson = buildMessageContentJson({
    text: displayMessageContent,
    images: imageParts,
  });
  const messageContentJson = baseMessageContentJson;

  const userMessage =
    existingUserMessage ??
    (await createMessageRecord({
      id: userMessageId,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: thread.id,
      parentMessageId: input.userMessageParentId ?? null,
      role: "user",
      content: displayMessageContent,
      contentJson: messageContentJson,
      createdBy: input.userId,
      metadata: {
        source: "api",
        ...(mentionedSourceIds.length > 0
          ? {
              mentionedSourceIds,
              effectiveMentionedSourceIds,
            }
          : {}),
        sourceIds: selectedSourceIds,
        effectiveSourceIds: sourceIds,
        skillIds: selectedSkillIds,
        ...(invokedSkillIds.length > 0 ? { invokedSkillIds } : {}),
        ...(resolvedCommand
          ? {
              command: buildThreadCommandMetadata(resolvedCommand),
            }
          : {}),
        options: buildTurnOptionsSnapshot({ tools: effectiveTools }),
        // Whatever the capabilities asked to have on the record. The pipeline
        // carries the fields without reading them.
        ...preflight.messageMetadata,
        versionOf: input.userMessageParentId ?? null,
      },
    }));
  const createdUserMessage = !existingUserMessage;

  const isFirstAssistantResponse = !messageRecords.some(
    (message) =>
      message.role === "assistant" && !isContextExcludedMessage(message),
  );
  const isFirstAssistantAttempt = !messageRecords.some(
    (message) => message.role === "assistant",
  );
  const initialTitle = thread.title;
  const persistedResolvedThreadSettings = applyResolvedThreadModelSettings(
    normalizedThreadSettingsWithSnapshots,
    requestedExecutionMode !== "BYOK" &&
      (requestedProfileAlias || requestedModelAlias)
      ? {
          llm: {
            profileAlias,
            modelAlias,
          },
        }
      : {},
  );

  const threadModelSettingsChanged = (
    Object.keys(
      persistedResolvedThreadSettings,
    ) as (keyof ThreadModelSettings)[]
  ).some(
    (key) =>
      persistedResolvedThreadSettings[key] !== originalThreadSettings[key],
  );

  if (threadModelSettingsChanged) {
    const updatedThread = await updateThreadModelSettingsRecord({
      threadId: thread.id,
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      modelSettings: persistedResolvedThreadSettings,
    });
    if (updatedThread) {
      thread = updatedThread;
    }
  }
  const agentMode = input.agentMode ?? "continue";
  const latestAssistantCheckpoint =
    agentMode === "continue"
      ? resolveLatestAssistantFinalCheckpoint(contextMessageRecords)
      : null;
  const agentBaseCheckpoint =
    input.agentBaseCheckpoint !== undefined
      ? input.agentBaseCheckpoint
      : latestAssistantCheckpoint;

  const llmIdempotencyKey =
    input.idempotencyKey ||
    (assistantMessageParentId
      ? `thread-refresh:${userMessage.id}:${assistantMessageParentId}:${randomUUID()}`
      : `thread-stream:${userMessage.id}:assistant`);

  const agentRunThreadId = input.agentRunThreadId ?? thread.id;
  const toolApprovalResume = input.toolApprovalResume ?? null;
  const traceContinuation = resolveTraceContinuationMetadata(
    input.assistantMessageId
      ? (messageRecords.find(
          (message) =>
            message.id === input.assistantMessageId &&
            message.role === "assistant",
        ) ?? null)
      : null,
  );
  const userMessageWithTraceId = existingUserMessage
    ? userMessage
    : ((await updateMessageMetadataRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        threadId: thread.id,
        messageId: userMessage.id,
        metadata: {
          ...userMessage.metadata,
          traceId: runTraceId,
        },
      })) ?? {
        ...userMessage,
        metadata: { ...userMessage.metadata, traceId: runTraceId },
      });

  if (pendingVisionFallbackBilling.length > 0) {
    preflightBilling = buildVisionFallbackPreflightBilling({
      items: pendingVisionFallbackBilling,
    });
  }

  return {
    userId: input.userId,
    workspace,
    thread,
    messageContent,
    messageContentJson,
    imageParts,
    preflightBilling,
    preflightThinkingSteps,
    agentMessageContent,
    mentionedSourceIds,
    effectiveMentionedSourceIds,
    selectedSourceIds,
    sourceIds,
    sourceScope,
    webAccessEnabled,
    command: resolvedCommand,
    invocation: resolvedInvocation,
    commandSuccessCriteria: commandSuccessCriteria ?? { kind: "none" },
    toolPermissions,
    effectiveTools,
    runtimeTools,
    turnState: preflight.turnState,
    timezone,
    userMessage: userMessageWithTraceId,
    runTraceId,
    createdUserMessage,
    assistantMessageParentId,
    assistantMessageId: input.assistantMessageId ?? null,
    assistantMessageIdOverride: input.assistantMessageIdOverride ?? null,
    profileAlias,
    modelAlias,
    providerModel,
    chatProfile,
    llm,
    llmIdempotencyKey,
    agentMode,
    agentBaseCheckpoint,
    agentRunThreadId,
    toolApprovalResume,
    traceContinuation,
    isFirstAssistantResponse,
    isFirstAssistantAttempt,
    initialTitle,
    failurePersistence: input.failurePersistence ?? "persist-error-turn",
    // The web client sends the MCP selection inside tools.mcp (sources-hub
    // picker); the top-level field remains for API callers. Without this
    // fallback the picker selection never reached the turn at all.
    mcpInstallIds:
      input.mcpInstallIds ?? mcpInstallIdsFromTools(input.tools) ?? [],
    enabledSkills,
    invokedSkillIds,
  };
}

/**
 * Narrow the untyped tools map's `mcp` entry to its install selection. The
 * route schema validates the shape, but ThreadToolsSelection is deliberately
 * opaque here, so re-narrow defensively.
 */
function mcpInstallIdsFromTools(
  tools: ThreadToolsSelection | undefined,
): string[] | undefined {
  const mcp = tools?.mcp;
  if (!mcp || typeof mcp !== "object") {
    return undefined;
  }
  const installIds = (mcp as { installIds?: unknown }).installIds;
  if (!Array.isArray(installIds)) {
    return undefined;
  }
  const ids = installIds
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .slice(0, 10);
  return ids.length > 0 ? ids : undefined;
}

function resolveLatestSourceIds(
  messageRecords: Awaited<ReturnType<typeof listMessageRecordsByThread>>,
) {
  const messages = collapseSupersededMessages(messageRecords).filter(
    (message) => !isContextExcludedMessage(message),
  );

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }

    const sourceIds = resolveSourceIdsFromMessage(message);
    if (sourceIds.length > 0) {
      return sourceIds;
    }
  }

  return [] as string[];
}

function resolveLatestAssistantFinalCheckpoint(
  messageRecords: Awaited<ReturnType<typeof listMessageRecordsByThread>>,
) {
  const messages = collapseSupersededMessages(messageRecords).filter(
    (message) => !isContextExcludedMessage(message),
  );

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }

    const checkpoint = resolveAgentCheckpointMetadata(message);
    if (checkpoint?.final) {
      return checkpoint.final;
    }
  }

  return null;
}
