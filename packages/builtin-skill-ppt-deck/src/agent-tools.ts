import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { ModelGateway } from "@sourceweft/model-gateway";
import type {
  AgentToolHostServices,
  AgentToolTurnContext,
} from "@sourceweft/contracts/agent-tools";
import { REVIEW_DECK_VISUALS_TOOL_NAME } from "./agent-tool-defs";
import { readReviewDeckVisualsTurnState } from "./turn-preflight";
import {
  aggregateDeckFindings,
  buildDeckVisualQaJudgePrompt,
  parseDeckVisualQaVerdicts,
  summarizeDeckVerdicts,
  type DeckVisualQaSlideVerdict,
} from "./visual-qa";

/**
 * The kind of model this capability calls. Vision rides the chat surface —
 * image blocks in a chat completion — which is the same shape the deliverable
 * host uses for video visual QA.
 */
type VisionModelSurface = Pick<ModelGateway, "chat">;

type CapabilityAgentToolFactoryInput = {
  readonly toolIds?: readonly string[];
  readonly context?: Partial<
    Pick<
      AgentToolTurnContext,
      "turnState" | "isToolDenied" | "traceId" | "threadId" | "userMessageId"
    >
  >;
  readonly services?: Partial<
    Pick<
      AgentToolHostServices<VisionModelSurface>,
      "modelGateway" | "sandbox" | "logger"
    >
  >;
};

/** The label this capability's vision spend settles under. */
const REVIEW_DECK_VISUALS_BILLING_FEATURE = "ppt_deck.visual_qa";

const MAX_IMAGES = 24;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const JUDGE_BATCH_SIZE = 8;
const JUDGE_MAX_TOKENS = 1600;

const reviewDeckVisualsInputSchema = z.object({
  imagePaths: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_IMAGES)
    .describe(
      "Sandbox paths of the rendered slide images, in deck order — the lines of $QA_DIR/slide-images.txt.",
    ),
});

function normalizeSandboxPath(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return absolute.replace(/\/$/gu, "") || "/";
}

function isUnderAllowedRoot(
  path: string,
  allowedRoots: readonly string[] | undefined,
) {
  if (!allowedRoots || allowedRoots.length === 0) {
    return true;
  }
  return allowedRoots.some((root) => {
    const normalizedRoot = normalizeSandboxPath(root);
    return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
  });
}

function mimeTypeForImagePath(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  return null;
}

function resolveToolRuntimeCallId(runtime: ToolRuntime) {
  const callId = (runtime as { toolCall?: { id?: unknown } }).toolCall?.id;
  return typeof callId === "string" && callId.length > 0 ? callId : null;
}

export function createCapabilityAgentTools(
  input: CapabilityAgentToolFactoryInput,
) {
  const context = input.context;
  const services = input.services;
  const state = readReviewDeckVisualsTurnState(
    context?.turnState,
    REVIEW_DECK_VISUALS_TOOL_NAME,
  );
  const sandbox = services?.sandbox;
  const modelGateway = services?.modelGateway;
  if (
    (input.toolIds && !input.toolIds.includes(REVIEW_DECK_VISUALS_TOOL_NAME)) ||
    !context ||
    context.isToolDenied?.(REVIEW_DECK_VISUALS_TOOL_NAME) === true ||
    !sandbox?.downloadCurrentFile ||
    !modelGateway
  ) {
    return { tools: [] };
  }

  const visionProfile = state?.visionProfile ?? null;
  const logger = services?.logger;

  const reviewDeckVisuals = tool(
    async (
      args: z.infer<typeof reviewDeckVisualsInputSchema>,
      runtime: ToolRuntime,
    ) => {
      if (!visionProfile) {
        return JSON.stringify({
          skipped: true,
          reason: "no_vision_profile",
        });
      }

      const images: Array<{
        slideNumber: number;
        data: Uint8Array;
        mimeType: string;
      }> = [];
      const rejectedPaths: string[] = [];
      for (const [index, rawPath] of args.imagePaths.entries()) {
        const path = normalizeSandboxPath(rawPath);
        const mimeType = mimeTypeForImagePath(path);
        if (!mimeType || !isUnderAllowedRoot(path, sandbox.allowedReadRoots)) {
          rejectedPaths.push(rawPath);
          continue;
        }
        try {
          const data = await sandbox.downloadCurrentFile({
            sandboxPath: path,
          });
          if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) {
            rejectedPaths.push(rawPath);
            continue;
          }
          images.push({ slideNumber: index + 1, data, mimeType });
        } catch {
          rejectedPaths.push(rawPath);
        }
      }
      if (images.length === 0) {
        return JSON.stringify({
          skipped: true,
          reason: "no_readable_images",
          rejectedPaths,
        });
      }

      const toolCallId =
        resolveToolRuntimeCallId(runtime) ??
        `${context.userMessageId ?? context.threadId ?? "review-deck-visuals"}`;
      const client = await modelGateway.getClient({
        gatewayConfigId: visionProfile.gatewayConfigId,
        feature: REVIEW_DECK_VISUALS_BILLING_FEATURE,
      });

      const verdicts: DeckVisualQaSlideVerdict[] = [];
      let failedBatches = 0;
      for (
        let offset = 0;
        offset < images.length;
        offset += JUDGE_BATCH_SIZE
      ) {
        const batch = images.slice(offset, offset + JUDGE_BATCH_SIZE);
        try {
          const result = await client.chat.complete(
            {
              model: visionProfile.modelAlias,
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: buildDeckVisualQaJudgePrompt({
                        slideNumbers: batch.map((image) => image.slideNumber),
                      }),
                    },
                    ...batch.map((image) => ({
                      type: "image_url" as const,
                      image_url: {
                        url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
                      },
                    })),
                  ],
                },
              ],
              temperature: 0,
              maxTokens: JUDGE_MAX_TOKENS,
              metadata: {
                feature: REVIEW_DECK_VISUALS_BILLING_FEATURE,
                operation: `${REVIEW_DECK_VISUALS_BILLING_FEATURE}.judge`,
              },
            },
            {
              operation: `${REVIEW_DECK_VISUALS_BILLING_FEATURE}.judge`,
              modelKind: "vision",
              gatewayConfigId: visionProfile.gatewayConfigId,
              profileAlias: visionProfile.profileAlias,
              modelAlias: visionProfile.modelAlias,
              idempotencyKey: `${toolCallId}:${offset}`,
              ...(context.traceId ? { traceId: context.traceId } : {}),
            },
          );
          const raw =
            typeof result.raw.content === "string"
              ? result.raw.content
              : JSON.stringify(result.raw.content);
          const parsed = parseDeckVisualQaVerdicts(raw);
          if (!parsed) {
            failedBatches += 1;
            logger?.warn?.("ppt_deck_visual_qa_unparseable_verdict", {
              slideNumbers: batch.map((image) => image.slideNumber),
            });
            continue;
          }
          verdicts.push(...parsed);
        } catch (error) {
          failedBatches += 1;
          logger?.warn?.("ppt_deck_visual_qa_judge_failed", {
            slideNumbers: batch.map((image) => image.slideNumber),
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (verdicts.length === 0) {
        return JSON.stringify({
          skipped: true,
          reason: "judge_unavailable",
          rejectedPaths,
        });
      }
      return JSON.stringify({
        verdicts,
        deckFindings: aggregateDeckFindings(verdicts),
        summary: {
          ...summarizeDeckVerdicts(verdicts),
          reviewedSlides: verdicts.length,
          failedBatches,
          rejectedPaths,
        },
      });
    },
    {
      name: REVIEW_DECK_VISUALS_TOOL_NAME,
      description:
        "Judge rendered slide images from the sandbox with the workspace's vision model. Pass the slide image paths from final QA in deck order; returns per-slide verdicts with severities, deck-level findings, and a summary, or {skipped, reason} when no vision profile is configured.",
      schema: reviewDeckVisualsInputSchema,
    },
  );

  return {
    tools: [{ tool: reviewDeckVisuals, categories: ["artifact"] as const }],
  };
}
