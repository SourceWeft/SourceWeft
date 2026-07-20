import {
  ARTIFACT_MIME_TYPES,
  mimeTypeForPath,
} from "@sourceweft/contracts/artifact-files";
import {
  ARTIFACT_WRITE_ERROR_CODES,
  isArtifactError,
} from "@sourceweft/contracts/artifact-errors";
import type {
  DeliverableHostContext,
  DeliverableJobEnvelope,
  DeliverableLlmInput,
  DeliverableStructuredLlmInput,
  DeliverableVisionInput,
} from "@sourceweft/capability-contracts";
import type {
  ChatCompleteInput,
  ThinkingConfig,
  TtsSpeechInput,
} from "@sourceweft/model-gateway";
import {
  buildGatewayRequestMetadata,
  type LlmExecutionConfig,
} from "../../modules/content/model-gateway-audit";
import type {
  BilledModelGateway,
  BilledRequestOptions,
  ModelUsageContext,
} from "../../shared/model-gateway";
import { probeAudioDurationSeconds } from "../../shared/audio-duration";
import { logger } from "../../shared/logger";
import {
  createDeliverableSandboxAdapter,
  loadDefaultSandboxService,
} from "./sandbox-session";

/**
 * Assembles the narrow DeliverableHostContext a capability pipeline runs
 * against: model-gateway chat/tts/vision adapters (with BYOK profile
 * resolution), storage, audio probing, sandbox sessions and a logger.
 * Generalized from the video-presentation worker's createDefaultDeps —
 * operation strings stay `${feature}.${metadata.stage}` so audit records and
 * billing idempotency keys are unchanged for video.
 *
 * Usage is settled by the billed gateway wrapper, not by this file: every model
 * call goes through `openBilledModelGateway`, which charges it against the job's
 * billing scope. There is deliberately no hand-rolled metering here.
 */

const DELIVERABLE_LLM_TIMEOUT_MS = 120_000;
const MAX_LLM_EMPTY_RETRIES = 2;

export type DeliverableHostJobPayload = DeliverableJobEnvelope & {
  llm?: LlmExecutionConfig;
};

export type DeliverableArtifactsAdapter = {
  find(input: {
    artifactId: string;
    teamId: string;
    workspaceId: string;
  }): Promise<{
    payloadJson?: unknown;
    /**
     * The artifact's published version pointer, read in the same row read that
     * supplies the payload. An edit run carries it to the completion as its
     * optimistic lock, so the base it regenerated from and the base it
     * republishes onto are guaranteed to be the same one.
     */
    currentVersionNo?: number;
    /** The artifact's own title, used to complete it through the write path. */
    title?: string | null;
  } | null>;
  markFailed(input: {
    artifactId: string;
    teamId?: string;
    workspaceId?: string;
    expectedStatuses?: Array<"pending" | "running" | "ready" | "failed">;
    errorCode: string;
    errorMessage: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown>;
  /**
   * Phase two of the artifact this job is finishing: the same
   * `completeArtifact` every producer closes a two-phase write with.
   *
   * The pipeline hands over what only it knows — the finished payload, its
   * artifact type, its thumbnail — and the host keeps what is host business:
   * the row, the version, the compare-and-swap.
   *
   * Resolves null when the artifact left `expectedStatuses`, or moved past
   * `expectedVersionNo`, before this run got here. That is a lost race, not a
   * failure: the writer raises it as an `ARTIFACT_STATE_CONFLICT`, and this
   * adapter turns it back into the null the host treats as "superseded" so a
   * duplicate delivery never damages the winner's artifact.
   */
  completeArtifact(input: {
    artifactId: string;
    artifactType: string;
    teamId: string;
    workspaceId: string;
    threadId: string;
    userId: string;
    title: string;
    payload: Record<string, unknown>;
    /**
     * A thumbnail the pipeline uploaded itself, mid-run, in the stage that
     * produced it. Omitted means "keep whatever thumbnail the artifact has".
     */
    preview?: { storageKey: string; metadata: Record<string, unknown> };
    expectedStatuses?: Array<"pending" | "running" | "ready" | "failed">;
    /** Optimistic lock on the artifact's published version (edit runs). */
    expectedVersionNo?: number;
  }): Promise<{ artifactId: string; versionId: string } | null>;
  markRunning(input: {
    artifactId: string;
    teamId?: string;
    workspaceId?: string;
    expectedStatuses?: Array<"pending" | "running" | "ready" | "failed">;
    payload?: Record<string, unknown>;
  }): Promise<unknown>;
};

export type DeliverableHostRuntime = {
  ctx: DeliverableHostContext;
  artifacts: DeliverableArtifactsAdapter;
};

export type DeliverableRuntimeResolver = (
  job: DeliverableHostJobPayload,
) => Promise<DeliverableHostRuntime>;

/**
 * "Someone else already finished this artifact", as the writer reports it.
 *
 * The repository's compare-and-swap answers with null and the writer raises
 * that as an error, because a one-shot publisher losing a race genuinely is
 * exceptional. A pipeline is the case where it is not: a duplicate BullMQ
 * delivery of an already-published job is ordinary, and the host's answer to it
 * is `superseded`, not a failure. So the code is recognized here and turned
 * back into the null the host was already written against — structurally, since
 * the error may cross a module boundary.
 */
function isArtifactStateConflict(error: unknown) {
  return (
    isArtifactError(error) &&
    error.code === ARTIFACT_WRITE_ERROR_CODES.stateConflict
  );
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && !Array.isArray(part)) {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
          if (typeof record.content === "string") return record.content;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function resolveWorkerThinking(input: {
  llm?: LlmExecutionConfig;
  profileConfig?: Record<string, unknown>;
}): ThinkingConfig {
  const supportedParameters = Array.isArray(
    input.profileConfig?.supportedParameters,
  )
    ? input.profileConfig.supportedParameters.filter(
        (value): value is string => typeof value === "string",
      )
    : input.llm?.thinking?.supportedParameters;
  const supportedEfforts = Array.isArray(input.profileConfig?.supportedEfforts)
    ? input.profileConfig.supportedEfforts.filter(
        (
          value,
        ): value is NonNullable<ThinkingConfig["supportedEfforts"]>[number] =>
          value === "minimal" ||
          value === "low" ||
          value === "medium" ||
          value === "high" ||
          value === "xhigh",
      )
    : input.llm?.thinking?.supportedEfforts;

  return {
    ...input.llm?.thinking,
    mode: input.llm?.thinking?.mode ?? "off",
    enabled: input.llm?.thinking?.enabled ?? false,
    includeReasoning: input.llm?.thinking?.includeReasoning ?? false,
    ...(supportedParameters ? { supportedParameters } : {}),
    ...(supportedEfforts ? { supportedEfforts } : {}),
  };
}

export function createDefaultDeliverableRuntimeResolver(input: {
  feature: string;
}): DeliverableRuntimeResolver {
  return async (job) => {
    const [repository, artifactPublish, storage, modelGateway] =
      await Promise.all([
        import("../../modules/artifacts/repository"),
        import("../../modules/artifacts/publish"),
        import("../../modules/sources/storage"),
        import("../../shared/model-gateway"),
      ]);
    const feature = input.feature;

    /**
     * One billing identity for the whole job. `scopeId` is the jobId, which is
     * what makes the wrapper's derived idempotency keys
     * (`${scopeId}:${operation}:${scopeKey}:${seq}`) byte-identical to the keys
     * the hand-rolled meter used to emit — a checkpoint-resumed job replays the
     * same keys instead of charging twice.
     */
    const billingContext: ModelUsageContext = {
      teamId: job.teamId,
      workspaceId: job.workspaceId,
      actorUserId: job.userId,
      feature,
      intent: { mode: "billed" },
      scopeKind: "worker-job",
      scopeId: job.jobId,
      threadId: job.threadId,
      messageId: job.userMessageId,
    };

    /**
     * Pinned verbatim from the previous meter: the reference every deliverable
     * call was charged against, and the metadata attached to it.
     */
    const billingReference = {
      referenceId: job.artifactId,
      billingMetadata: { artifactId: job.artifactId, jobId: job.jobId },
    } satisfies Pick<BilledRequestOptions, "referenceId" | "billingMetadata">;

    /**
     * Each profile kind sits on its own gateway config, so each gets its own
     * billed gateway and therefore its own settlement scope. The per-scope
     * sequence counters stay equivalent to the single shared counter they
     * replace because the operation strings are disjoint across kinds: chat
     * calls are `${feature}.${stage}`, and tts/vision/image are the reserved
     * `${feature}.tts`, `${feature}.visual_qa` and `${feature}.asset_image`.
     */
    const openGateway = async (gatewayConfigId: string) => {
      const { billingService } = await import("../../modules/billing");
      const { gateway } = await modelGateway.openBilledModelGateway({
        billing: billingService,
        context: billingContext,
        gatewayConfigId,
      });
      return gateway;
    };

    let modelDeps: Promise<{
      chatGateway: BilledModelGateway;
      chatProfile: NonNullable<
        Awaited<ReturnType<typeof modelGateway.resolveModelGatewayProfile>>
      >;
      ttsGateway: BilledModelGateway;
      ttsProfile: Awaited<
        ReturnType<typeof modelGateway.requireDefaultModelGatewayProfile>
      >;
    }> | null = null;
    const resolveModelDeps = () => {
      modelDeps ??= (async () => {
        const [chatProfile, ttsProfile] = await Promise.all([
          modelGateway.resolveModelGatewayProfile({
            kind: "chat",
            requestedProfileAlias:
              job.llm?.executionMode === "BYOK"
                ? undefined
                : job.llm?.profileAlias,
            requestedModelAlias:
              job.llm?.executionMode === "BYOK"
                ? undefined
                : job.llm?.modelAlias,
            defaultRequired: true,
          }),
          modelGateway.requireDefaultModelGatewayProfile("tts"),
        ]);
        if (!chatProfile) {
          throw new Error(
            "Default chat model gateway profile is not configured",
          );
        }
        const [chatGateway, ttsGateway] = await Promise.all([
          openGateway(chatProfile.gatewayConfigId),
          openGateway(ttsProfile.gatewayConfigId),
        ]);
        return { chatGateway, chatProfile, ttsGateway, ttsProfile };
      })();
      return modelDeps;
    };

    let visionDeps: Promise<{
      visionGateway: BilledModelGateway;
      visionProfile: Awaited<
        ReturnType<typeof modelGateway.requireDefaultModelGatewayProfile>
      >;
    }> | null = null;
    const resolveVisionDeps = () => {
      visionDeps ??= (async () => {
        const visionProfile =
          await modelGateway.requireDefaultModelGatewayProfile("vision");
        const visionGateway = await openGateway(visionProfile.gatewayConfigId);
        return { visionGateway, visionProfile };
      })();
      return visionDeps;
    };

    // Memoised for the same reason the others are, and additionally because a
    // fresh gateway per call would restart the scope's sequence counter and
    // emit the same idempotency key for every generated image in a job.
    let imageDeps: Promise<{
      imageGateway: BilledModelGateway;
      imageProfile: Awaited<
        ReturnType<typeof modelGateway.requireDefaultModelGatewayProfile>
      >;
    }> | null = null;
    const resolveImageDeps = () => {
      imageDeps ??= (async () => {
        const imageProfile =
          await modelGateway.requireDefaultModelGatewayProfile("image");
        const imageGateway = await openGateway(imageProfile.gatewayConfigId);
        return { imageGateway, imageProfile };
      })();
      return imageDeps;
    };

    const buildChatCall = async (
      llmInput: DeliverableLlmInput,
      structuredOutput?: ChatCompleteInput["structuredOutput"],
    ) => {
      const { chatGateway, chatProfile } = await resolveModelDeps();
      const isByok = job.llm?.executionMode === "BYOK";
      const thinking = resolveWorkerThinking({
        llm: job.llm,
        profileConfig: chatProfile.configJson,
      });
      const stage =
        typeof llmInput.metadata.stage === "string"
          ? llmInput.metadata.stage
          : "generate";
      const operation = `${feature}.${stage}`;
      const auditMetadata = buildGatewayRequestMetadata({
        teamId: job.teamId,
        workspaceId: job.workspaceId,
        userId: job.userId,
        threadId: job.threadId,
        messageId: job.userMessageId,
        feature,
        operation,
        modelKind: "chat",
        modelAlias: chatProfile.modelAlias,
        profileAlias: isByok ? null : chatProfile.profileAlias,
        llm: job.llm,
        parentSpanId: job.parentSpanId,
      });
      const request: ChatCompleteInput = {
        model: isByok
          ? (job.llm?.providerModel ??
            job.llm?.modelAlias ??
            chatProfile.modelAlias)
          : chatProfile.modelAlias,
        messages: llmInput.messages as unknown as ChatCompleteInput["messages"],
        temperature: llmInput.temperature,
        maxTokens: llmInput.maxTokens,
        metadata: {
          // The billed wrapper owns the request *options* metadata, so the
          // audit fields it does not carry (parentSpanId, observationName, BYOK
          // key provenance) ride on the request metadata instead.
          ...auditMetadata,
          ...llmInput.metadata,
          teamId: job.teamId,
          workspaceId: job.workspaceId,
          userId: job.userId,
          threadId: job.threadId,
          messageId: job.userMessageId,
          profileAlias: isByok ? null : chatProfile.profileAlias,
          modelAlias: isByok
            ? (job.llm?.modelAlias ?? job.llm?.providerModel ?? null)
            : chatProfile.modelAlias,
          providerModel: job.llm?.providerModel ?? chatProfile.modelAlias,
          thinkingMode: thinking.mode,
        },
        ...(structuredOutput ? { structuredOutput } : {}),
        ...(isByok
          ? {
              executionMode: "BYOK" as const,
              providerHint: job.llm?.providerHint,
              byokModelId: job.llm?.byokModelId,
              credentialId: job.llm?.credentialId,
              byok: job.llm?.byok,
            }
          : {
              executionMode: "GLOBAL" as const,
              profileAlias: chatProfile.profileAlias,
            }),
        thinking,
      };
      return {
        chatGateway,
        request,
        options: {
          traceId: job.traceId ?? job.jobId,
          timeoutMs: DELIVERABLE_LLM_TIMEOUT_MS,
          operation,
          modelKind: "chat",
          gatewayConfigId: chatProfile.gatewayConfigId,
          profileAlias: chatProfile.profileAlias,
          modelAlias: chatProfile.modelAlias,
          llm: job.llm,
          scopeKey:
            typeof llmInput.metadata.slideNumber === "number"
              ? llmInput.metadata.slideNumber
              : undefined,
          ...billingReference,
        } satisfies BilledRequestOptions,
      };
    };

    const ctx: DeliverableHostContext = {
      logger,
      llm: {
        complete: async (llmInput) => {
          const { chatGateway, request, options } =
            await buildChatCall(llmInput);
          for (
            let attempt = 0;
            attempt <= MAX_LLM_EMPTY_RETRIES;
            attempt += 1
          ) {
            const result = await chatGateway.chat.complete(
              {
                ...request,
                metadata: { ...request.metadata, attempt },
              },
              options,
            );
            const content = extractTextContent(result.raw.content);
            if (content.trim()) {
              return content;
            }
          }
          throw new Error(
            "Deliverable pipeline LLM returned empty content after 3 successful responses",
          );
        },
        completeStructured: async (llmInput: DeliverableStructuredLlmInput) => {
          // Declare only the schema and let LangChain pick the
          // structured-output method per model (json_schema for deepseek).
          const structuredOutput = {
            name: llmInput.schemaName,
            schema: llmInput.schema,
          };
          const runOnce = async (
            messages: DeliverableStructuredLlmInput["messages"],
          ) => {
            const { chatGateway, request, options } = await buildChatCall(
              { ...llmInput, messages },
              structuredOutput,
            );
            const result = await chatGateway.chat.complete(request, options);
            if (!result.structuredOutput) {
              throw new Error(
                "Deliverable pipeline LLM returned no parsed structured output",
              );
            }
            return result.structuredOutput;
          };

          const first = await runOnce(llmInput.messages);
          if (!llmInput.validate) {
            return first;
          }
          const verdict = llmInput.validate(first);
          if (verdict.ok) {
            return first;
          }
          // One repair attempt on the same model/method, showing the model
          // its previous output and the validation feedback.
          const repaired = await runOnce([
            ...llmInput.messages,
            { role: "assistant", content: JSON.stringify(first) },
            {
              role: "user",
              content: [
                "The previous response failed validation and was rejected.",
                verdict.feedback,
                "Return a corrected response that satisfies the schema and these constraints. Output only the structured result.",
              ].join("\n\n"),
            },
          ]);
          return repaired;
        },
        completeVision: async (visionInput: DeliverableVisionInput) => {
          const { visionGateway, visionProfile } = await resolveVisionDeps();
          const content = [
            { type: "text" as const, text: visionInput.prompt },
            ...visionInput.images.map((image) => ({
              type: "image_url" as const,
              image_url: {
                url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
              },
            })),
          ];
          const result = await visionGateway.chat.complete(
            {
              model: visionProfile.modelAlias,
              messages: [{ role: "user", content }],
              temperature: visionInput.temperature ?? 0,
              maxTokens: visionInput.maxTokens ?? 1600,
              metadata: {
                ...visionInput.metadata,
                feature,
                operation: `${feature}.visual_qa`,
              },
            },
            {
              traceId: job.traceId ?? job.jobId,
              timeoutMs: DELIVERABLE_LLM_TIMEOUT_MS,
              operation: `${feature}.visual_qa`,
              modelKind: "vision",
              gatewayConfigId: visionProfile.gatewayConfigId,
              profileAlias: visionProfile.profileAlias,
              modelAlias: visionProfile.modelAlias,
              llm: job.llm,
              ...billingReference,
            },
          );
          return extractTextContent(result.raw.content);
        },
      },
      tts: {
        speech: async (ttsInput) => {
          const { ttsGateway, ttsProfile } = await resolveModelDeps();
          const request: TtsSpeechInput = {
            model: ttsProfile.modelAlias,
            input: ttsInput.text,
            responseFormat: "mp3",
            metadata: ttsInput.metadata,
          };
          const result = await ttsGateway.tts.speech(request, {
            operation: `${feature}.tts`,
            modelKind: "tts",
            gatewayConfigId: ttsProfile.gatewayConfigId,
            profileAlias: ttsProfile.profileAlias,
            modelAlias: ttsProfile.modelAlias,
            llm: job.llm,
            scopeKey:
              typeof ttsInput.metadata?.slideNumber === "number"
                ? (ttsInput.metadata.slideNumber as number)
                : undefined,
            ...billingReference,
          });
          return {
            audio: Buffer.from(result.audio),
            mimeType: result.mimeType || "audio/mpeg",
          };
        },
      },
      storage: storage.artifactStorage,
      audio: {
        probeDurationSeconds: (probeInput) =>
          probeAudioDurationSeconds({
            buffer: Buffer.from(probeInput.buffer),
            mimeType: probeInput.mimeType,
          }),
      },
      assets: {
        // Resolve a user-provided asset id (an image artifact in this
        // workspace) to raw bytes so pipelines can copy it into their own
        // artifact namespace.
        fetchImage: async ({ assetId }) => {
          try {
            const record = await repository.findArtifactRecord({
              artifactId: assetId,
              teamId: job.teamId,
              workspaceId: job.workspaceId,
            });
            const recordShape = record as
              | {
                  artifactType?: string;
                  status?: string;
                  storageKey?: string | null;
                  storageBucket?: string | null;
                  payloadJson?: unknown;
                }
              | null;
            if (
              !recordShape ||
              recordShape.artifactType !== "image" ||
              recordShape.status !== "ready" ||
              !recordShape.storageKey
            ) {
              return null;
            }
            const body = await storage.downloadArtifactObject({
              bucket: recordShape.storageBucket,
              key: recordShape.storageKey,
            });
            const payload = recordShape.payloadJson as
              | { mimeType?: string }
              | undefined;
            const mimeType =
              typeof payload?.mimeType === "string"
                ? payload.mimeType
                : mimeTypeForPath(
                    recordShape.storageKey,
                    ARTIFACT_MIME_TYPES.jpeg,
                  );
            return {
              data: Buffer.isBuffer(body) ? body : Buffer.from(body as never),
              mimeType,
            };
          } catch (error) {
            logger.warn("deliverable_asset_fetch_failed", {
              assetId,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          }
        },
      },
      image: {
        // Best-effort generated imagery: no image profile configured or a
        // provider failure yields null, never an error.
        generate: async ({ prompt, metadata }) => {
          try {
            const { imageGateway, imageProfile } = await resolveImageDeps();
            const result = await imageGateway.images.generate(
              {
                model: imageProfile.modelAlias,
                prompt,
                count: 1,
                metadata: {
                  ...metadata,
                  feature,
                  operation: `${feature}.asset_image`,
                },
              },
              {
                traceId: job.traceId ?? job.jobId,
                operation: `${feature}.asset_image`,
                modelKind: "image",
                gatewayConfigId: imageProfile.gatewayConfigId,
                profileAlias: imageProfile.profileAlias,
                modelAlias: imageProfile.modelAlias,
                llm: job.llm,
                ...billingReference,
              },
            );
            const image = result.images[0];
            if (!image) {
              return null;
            }
            if (image.b64Json) {
              return {
                data: Buffer.from(image.b64Json, "base64"),
                mimeType: image.mimeType || "image/png",
              };
            }
            if (image.url) {
              const response = await fetch(image.url);
              if (!response.ok) {
                return null;
              }
              return {
                data: Buffer.from(await response.arrayBuffer()),
                mimeType:
                  response.headers.get("content-type") ||
                  image.mimeType ||
                  "image/png",
              };
            }
            return null;
          } catch (error) {
            logger.warn("deliverable_asset_image_generate_failed", {
              feature,
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          }
        },
      },
      sandbox: await (async () => {
        const sandboxService = await loadDefaultSandboxService();
        if (!sandboxService) {
          return undefined;
        }
        const adapter = createDeliverableSandboxAdapter({ sandboxService });
        return {
          createSession: async () => adapter.createSession({ job }),
        };
      })(),
    };

    return {
      ctx,
      artifacts: {
        find: repository.findArtifactRecord,
        markFailed: repository.markArtifactFailed,
        completeArtifact: async (input) => {
          try {
            const result = await artifactPublish.completeArtifact({
              artifactId: input.artifactId,
              context: {
                teamId: input.teamId,
                workspaceId: input.workspaceId,
                threadId: input.threadId,
                userId: input.userId,
              },
              spec: {
                artifactType: input.artifactType,
                title: input.title,
                // The payload is handed over whole and written whole: a
                // deliverable's finalize() returns the complete artifact, not a
                // patch, and republishing a subset would silently drop
                // everything the previous version carried.
                payload: input.payload,
              },
              ...(input.preview
                ? {
                    storedPreview: {
                      storageKey: input.preview.storageKey,
                      metadata: input.preview.metadata,
                    },
                  }
                : {}),
              ...(input.expectedStatuses
                ? { expectedStatuses: input.expectedStatuses }
                : {}),
              ...(input.expectedVersionNo === undefined
                ? {}
                : { expectedVersionNo: input.expectedVersionNo }),
            });
            return {
              artifactId: result.artifactId,
              versionId: result.versionId,
            };
          } catch (error) {
            if (isArtifactStateConflict(error)) {
              return null;
            }
            throw error;
          }
        },
        markRunning: repository.markArtifactRunning,
      },
    };
  };
}
