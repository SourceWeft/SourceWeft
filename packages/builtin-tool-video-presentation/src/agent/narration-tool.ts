import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { ModelGateway } from "@sourceweft/model-gateway";
import type {
  AgentToolLlmExecutionConfig,
  AgentToolMediaServices,
  AgentToolModelGatewayService,
  AgentToolModelProfileView,
  AgentToolOperationCacheServices,
  AgentToolSandboxServices,
  AgentToolWorkBlobServices,
} from "@sourceweft/contracts/agent-tools";
import {
  extensionForMimeType,
  resolveSynthesizedAudioMimeType,
} from "../pipeline/audio";
import { GENERATE_VIDEO_NARRATION_TOOL_NAME } from "./agent-tool-defs";
import {
  knownVideoProviderFailure,
  resolveVideoGatewayExecution,
  resolveVideoToolAbortSignal,
  resolveVideoToolCallId,
  sha256Digest,
  throwVideoToolAbortReason,
  videoModelSemanticIdentity,
  videoSemanticFailure,
  videoToolBlocked,
  type VideoSemanticFailureObservation,
} from "./common";

type TtsGateway = Pick<ModelGateway, "tts">;

const narrationRequestSchema = z
  .object({
    slideNumber: z.number().int().min(1).max(12),
    text: z.string().trim().min(1).max(4000),
  })
  .strict();

const generateVideoNarrationSchema = z
  .object({
    projectRoot: z.string().trim().min(1).max(1000),
    voice: z.string().trim().min(1).max(120).optional(),
    tracks: z.array(narrationRequestSchema).min(1).max(12),
  })
  .strict();

const narrationSuccessObservationSchema = z
  .object({
    status: z.literal("succeeded"),
    slideNumber: z.number().int(),
    blobRef: z.string(),
    contentDigest: z.string(),
    contentType: z.string(),
    durationSeconds: z.number().positive(),
    fileName: z.string(),
    provider: z.string().optional(),
    providerModel: z.string().optional(),
  })
  .strict();

const semanticFailureSchema = z
  .object({
    status: z.literal("failed"),
    code: z.string(),
    message: z.string(),
  })
  .strict();

const cachedNarrationObservationSchema = z.union([
  narrationSuccessObservationSchema,
  semanticFailureSchema,
]);

type NarrationSuccessObservation = z.infer<
  typeof narrationSuccessObservationSchema
>;

function narrationSandboxPath(projectRoot: string, fileName: string) {
  return `${projectRoot.replace(/\/+$/u, "")}/public/audio/${fileName}`;
}

function narrationOutput(
  observation: NarrationSuccessObservation,
  projectRoot: string,
) {
  const { status: _status, ...rest } = observation;
  return {
    ...rest,
    sandboxPath: narrationSandboxPath(projectRoot, observation.fileName),
  };
}

function failureDiagnostic(
  slideNumber: number,
  failure: VideoSemanticFailureObservation,
) {
  return { slideNumber, code: failure.code, message: failure.message };
}

export function createGenerateVideoNarrationTool(input: {
  profile: AgentToolModelProfileView | null;
  execution?: AgentToolLlmExecutionConfig;
  traceId?: string;
  services: {
    media: AgentToolMediaServices;
    modelGateway: AgentToolModelGatewayService<TtsGateway>;
    operationCache: AgentToolOperationCacheServices;
    sandbox: Required<AgentToolSandboxServices>;
    workBlobs: AgentToolWorkBlobServices;
  };
}) {
  return tool(
    async (args, runtime: ToolRuntime) => {
      if (input.execution?.executionMode === "BYOK") {
        return videoToolBlocked({
          code: "VIDEO_TTS_BYOK_UNSUPPORTED",
          message:
            "Narration BYOK is not available because the current turn has no routable TTS BYOK execution path.",
        });
      }
      if (!input.profile) {
        return videoToolBlocked({
          code: "VIDEO_TTS_PROFILE_UNAVAILABLE",
          message: "No configured narration model profile is available.",
        });
      }
      const profile = input.profile;
      const toolCallId = resolveVideoToolCallId(runtime);
      const abortSignal = resolveVideoToolAbortSignal(runtime);
      if (
        new Set(args.tracks.map((track) => track.slideNumber)).size !==
        args.tracks.length
      ) {
        return videoToolBlocked({
          code: "VIDEO_NARRATION_DUPLICATE_SLIDE",
          message:
            "Each narration batch item must target a unique slideNumber.",
        });
      }
      await input.services.sandbox.ensureCurrentSession();
      const providerIdentity = videoModelSemanticIdentity(
        profile,
        input.execution,
      );
      const gatewayExecution = resolveVideoGatewayExecution(
        profile,
        input.execution,
      );
      const semanticByKey = new Map(
        args.tracks.map((track) => {
          const semanticKey = sha256Digest(
            JSON.stringify({
              version: 2,
              provider: providerIdentity,
              voice: args.voice ?? null,
              slideNumber: track.slideNumber,
              text: track.text,
            }),
          );
          return [semanticKey, track] as const;
        }),
      );
      if (semanticByKey.size !== args.tracks.length) {
        return videoToolBlocked({
          code: "VIDEO_NARRATION_DUPLICATE_SEMANTICS",
          message: "The narration batch contains duplicate tracks.",
        });
      }
      const claim = await input.services.operationCache.claimMany({
        toolName: GENERATE_VIDEO_NARRATION_TOOL_NAME,
        toolCallId,
        semanticKeys: [...semanticByKey.keys()],
        executionScope: "root_only",
      });
      if (claim.kind === "wait") {
        return videoToolBlocked({
          code: "VIDEO_NARRATION_IN_PROGRESS",
          message: "An overlapping narration generation is already running.",
        });
      }
      if (claim.kind === "unknown") {
        return videoToolBlocked({
          code: claim.code,
          message:
            "A prior narration generation has an unknown provider outcome.",
        });
      }
      let clientPromise: ReturnType<
        typeof input.services.modelGateway.getClient
      > | null = null;
      const providerClient = () => {
        clientPromise ??= input.services.modelGateway.getClient({
          gatewayConfigId: profile.gatewayConfigId,
          feature: "artifact.video_presentation.narration",
        });
        return clientPromise;
      };
      const outputs: Array<ReturnType<typeof narrationOutput>> = [];
      const diagnostics: Array<Record<string, unknown>> = [];
      const pendingExecuteItems = new Map(
        claim.items.flatMap((item) =>
          item.action === "execute" ? [[item.semanticKey, item] as const] : [],
        ),
      );

      const markUnknown = async (
        item: Extract<(typeof claim.items)[number], { action: "execute" }>,
        reason: string,
      ) => {
        await input.services.operationCache
          .markUnknown({
            toolName: GENERATE_VIDEO_NARRATION_TOOL_NAME,
            semanticKey: item.semanticKey,
            claimToken: item.claimToken,
            reason,
          })
          .catch(() => undefined);
        pendingExecuteItems.delete(item.semanticKey);
      };
      const markPendingUnknown = async (reason: string) => {
        await Promise.all(
          [...pendingExecuteItems.values()].map((item) =>
            markUnknown(item, reason),
          ),
        );
      };
      const completeFailure = async (
        item: Extract<(typeof claim.items)[number], { action: "execute" }>,
        failure: VideoSemanticFailureObservation,
      ) => {
        const complete = () =>
          input.services.operationCache.complete({
            toolName: GENERATE_VIDEO_NARRATION_TOOL_NAME,
            semanticKey: item.semanticKey,
            claimToken: item.claimToken,
            observation: failure,
          });
        try {
          await complete();
          pendingExecuteItems.delete(item.semanticKey);
          return true;
        } catch {
          try {
            await complete();
            pendingExecuteItems.delete(item.semanticKey);
            return true;
          } catch {
            await markUnknown(item, "NARRATION_FAILURE_OBSERVATION_UNKNOWN");
            return false;
          }
        }
      };

      for (const item of claim.items) {
        const request = semanticByKey.get(item.semanticKey);
        if (!request) {
          throw new Error("VIDEO_NARRATION_CLAIM_IDENTITY_MISMATCH");
        }
        if (item.action === "reuse") {
          try {
            const cached = cachedNarrationObservationSchema.parse(
              item.observation,
            );
            if (cached.status === "failed") {
              diagnostics.push(failureDiagnostic(request.slideNumber, cached));
              continue;
            }
            if (cached.slideNumber !== request.slideNumber) {
              throw new Error("VIDEO_NARRATION_CACHE_IDENTITY_MISMATCH");
            }
            const stored = await input.services.workBlobs.getVerified({
              blobRef: cached.blobRef,
              contentDigest: cached.contentDigest,
            });
            if (!stored) {
              throw new Error("VIDEO_NARRATION_DURABLE_BYTES_MISSING");
            }
            const output = narrationOutput(cached, args.projectRoot);
            await input.services.sandbox.uploadCurrentFiles(
              [{ path: output.sandboxPath, bytes: stored.bytes }],
              abortSignal ? { signal: abortSignal } : undefined,
            );
            outputs.push(output);
          } catch (error) {
            diagnostics.push({
              slideNumber: request.slideNumber,
              code:
                error instanceof Error
                  ? error.message.slice(0, 200)
                  : "VIDEO_NARRATION_CACHE_RESTAGE_FAILED",
            });
          }
          continue;
        }

        let result: Awaited<
          ReturnType<
            Awaited<ReturnType<typeof providerClient>>["tts"]["speech"]
          >
        >;
        let client: Awaited<ReturnType<typeof providerClient>>;
        try {
          client = await providerClient();
        } catch {
          if (abortSignal?.aborted) {
            await markPendingUnknown("NARRATION_TOOL_ABORTED");
            throwVideoToolAbortReason(abortSignal);
          }
          const failure = videoSemanticFailure(
            "VIDEO_NARRATION_PROVIDER_UNAVAILABLE",
            "The narration provider is not configured for this request.",
          );
          if (await completeFailure(item, failure)) {
            diagnostics.push(failureDiagnostic(request.slideNumber, failure));
          } else {
            diagnostics.push({
              slideNumber: request.slideNumber,
              code: "VIDEO_NARRATION_PROVIDER_OUTCOME_UNKNOWN",
            });
          }
          continue;
        }
        try {
          result = await client.tts.speech(
            {
              ...gatewayExecution,
              input: request.text,
              ...(args.voice ? { voice: args.voice } : {}),
              responseFormat: "mp3",
            },
            {
              traceId: input.traceId,
              operation: "video.narration.generate",
              modelKind: "tts",
              gatewayConfigId: profile.gatewayConfigId,
              profileAlias: profile.profileAlias,
              modelAlias: gatewayExecution.model,
              idempotencyKey: `video-narration:${item.semanticKey}`,
              ...(abortSignal ? { signal: abortSignal } : {}),
              llm: input.execution,
            },
          );
          throwVideoToolAbortReason(abortSignal);
        } catch (error) {
          if (abortSignal?.aborted) {
            await markPendingUnknown("NARRATION_TOOL_ABORTED");
            throwVideoToolAbortReason(abortSignal);
          }
          const known = knownVideoProviderFailure({
            error,
            codePrefix: "VIDEO_NARRATION",
            providerLabel: "narration",
          });
          if (known && (await completeFailure(item, known))) {
            diagnostics.push(failureDiagnostic(request.slideNumber, known));
          } else {
            await markUnknown(item, "NARRATION_PROVIDER_OUTCOME_UNKNOWN");
            diagnostics.push({
              slideNumber: request.slideNumber,
              code: "VIDEO_NARRATION_PROVIDER_OUTCOME_UNKNOWN",
            });
          }
          continue;
        }

        const audio = new Uint8Array(result.audio);
        if (audio.byteLength === 0) {
          const failure = videoSemanticFailure(
            "VIDEO_NARRATION_PROVIDER_RETURNED_EMPTY_AUDIO",
            "The narration provider returned empty audio.",
          );
          if (await completeFailure(item, failure)) {
            diagnostics.push(failureDiagnostic(request.slideNumber, failure));
          } else {
            diagnostics.push({
              slideNumber: request.slideNumber,
              code: "VIDEO_NARRATION_PROVIDER_OUTCOME_UNKNOWN",
            });
          }
          continue;
        }
        let contentType: string;
        try {
          contentType = resolveSynthesizedAudioMimeType({
            audio,
            mimeType: result.mimeType ?? "audio/mpeg",
          });
        } catch {
          const failure = videoSemanticFailure(
            "VIDEO_NARRATION_AUDIO_FORMAT_INVALID",
            "The narration provider returned an unsupported audio format.",
          );
          if (await completeFailure(item, failure)) {
            diagnostics.push(failureDiagnostic(request.slideNumber, failure));
          } else {
            diagnostics.push({
              slideNumber: request.slideNumber,
              code: "VIDEO_NARRATION_PROVIDER_OUTCOME_UNKNOWN",
            });
          }
          continue;
        }
        const contentDigest = sha256Digest(audio);
        let stored: Awaited<
          ReturnType<typeof input.services.workBlobs.putIfAbsent>
        >;
        try {
          stored = await input.services.workBlobs.putIfAbsent({
            semanticKey: item.semanticKey,
            bytes: audio,
            contentType,
            contentDigest,
            ttlSeconds: 24 * 60 * 60,
          });
        } catch {
          await markUnknown(item, "NARRATION_DURABLE_BYTES_UNKNOWN");
          diagnostics.push({
            slideNumber: request.slideNumber,
            code: "VIDEO_NARRATION_PROVIDER_OUTCOME_UNKNOWN",
          });
          continue;
        }
        let durationSeconds: number | null = null;
        try {
          durationSeconds =
            await input.services.media.probeAudioDurationSeconds({
              bytes: audio,
              mimeType: contentType,
            });
        } catch {
          durationSeconds = null;
        }
        if (!durationSeconds || durationSeconds <= 0) {
          const failure = videoSemanticFailure(
            "VIDEO_NARRATION_AUDIO_NOT_DECODABLE",
            "The narration audio could not be decoded.",
          );
          if (await completeFailure(item, failure)) {
            diagnostics.push(failureDiagnostic(request.slideNumber, failure));
          } else {
            diagnostics.push({
              slideNumber: request.slideNumber,
              code: "VIDEO_NARRATION_PROVIDER_OUTCOME_UNKNOWN",
            });
          }
          continue;
        }
        const fileName = `slide-${request.slideNumber}${extensionForMimeType(contentType)}`;
        const cached: NarrationSuccessObservation = {
          status: "succeeded",
          slideNumber: request.slideNumber,
          blobRef: stored.blobRef,
          contentDigest,
          contentType,
          durationSeconds,
          fileName,
          ...(result.provider ? { provider: result.provider } : {}),
          ...(result.providerModel
            ? { providerModel: result.providerModel }
            : {}),
        };
        try {
          try {
            await input.services.operationCache.complete({
              toolName: GENERATE_VIDEO_NARRATION_TOOL_NAME,
              semanticKey: item.semanticKey,
              claimToken: item.claimToken,
              observation: cached,
            });
          } catch {
            const durable = await input.services.workBlobs.getBySemanticKey({
              semanticKey: item.semanticKey,
            });
            if (!durable || durable.contentDigest !== contentDigest) {
              throw new Error("VIDEO_NARRATION_OBSERVATION_COMMIT_UNKNOWN");
            }
            await input.services.operationCache.complete({
              toolName: GENERATE_VIDEO_NARRATION_TOOL_NAME,
              semanticKey: item.semanticKey,
              claimToken: item.claimToken,
              observation: cached,
            });
          }
          pendingExecuteItems.delete(item.semanticKey);
        } catch {
          await markUnknown(item, "NARRATION_OBSERVATION_COMMIT_UNKNOWN");
          diagnostics.push({
            slideNumber: request.slideNumber,
            code: "VIDEO_NARRATION_PROVIDER_OUTCOME_UNKNOWN",
          });
          continue;
        }
        const output = narrationOutput(cached, args.projectRoot);
        try {
          await input.services.sandbox.uploadCurrentFiles(
            [{ path: output.sandboxPath, bytes: audio }],
            abortSignal ? { signal: abortSignal } : undefined,
          );
          outputs.push(output);
        } catch {
          diagnostics.push({
            slideNumber: request.slideNumber,
            code: "VIDEO_NARRATION_SANDBOX_RESTAGE_FAILED",
          });
        }
      }
      throwVideoToolAbortReason(abortSignal);
      return {
        status:
          diagnostics.length === 0
            ? ("succeeded" as const)
            : ("failed" as const),
        tracks: outputs,
        diagnostics,
      };
    },
    {
      name: GENERATE_VIDEO_NARRATION_TOOL_NAME,
      description:
        "Generate and measure a bounded narration batch for the current video draft. Claims all tracks first, stores durable WIP audio before observation completion, and stages exact bytes into the active sandbox.",
      schema: generateVideoNarrationSchema,
    },
  );
}
