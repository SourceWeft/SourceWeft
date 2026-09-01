import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { ModelGateway } from "@sourceweft/model-gateway";
import type {
  AgentToolLlmExecutionConfig,
  AgentToolModelGatewayService,
  AgentToolModelProfileView,
  AgentToolOperationCacheServices,
  AgentToolSandboxServices,
  AgentToolWorkBlobServices,
} from "@sourceweft/contracts/agent-tools";
import { videoPresentationAssetTypeSchema } from "@sourceweft/contracts/video-presentation";
import {
  imageExtensionForMimeType,
  safeStorageSegment,
} from "../pipeline/util";
import { GENERATE_VIDEO_ASSETS_TOOL_NAME } from "./agent-tool-defs";
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

type ImageGateway = Pick<ModelGateway, "images">;

const assetRequestSchema = z
  .object({
    assetId: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(4000),
    type: videoPresentationAssetTypeSchema,
    slideNumbers: z.array(z.number().int().min(1).max(12)).min(1).max(12),
  })
  .strict();

const generateVideoAssetsSchema = z
  .object({
    projectRoot: z.string().trim().min(1).max(1000),
    assets: z.array(assetRequestSchema).min(1).max(12),
  })
  .strict();

const assetSuccessObservationSchema = z
  .object({
    status: z.literal("succeeded"),
    assetId: z.string(),
    blobRef: z.string(),
    contentDigest: z.string(),
    contentType: z.string(),
    fileName: z.string(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
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

const cachedAssetObservationSchema = z.union([
  assetSuccessObservationSchema,
  semanticFailureSchema,
]);

type AssetSuccessObservation = z.infer<typeof assetSuccessObservationSchema>;

function decodeInlineImage(input: { b64Json?: string; mimeType?: string }) {
  if (!input.b64Json) {
    return null;
  }
  const bytes = new Uint8Array(Buffer.from(input.b64Json, "base64"));
  return bytes.byteLength > 0
    ? { bytes, contentType: input.mimeType ?? "image/png" }
    : null;
}

function assetSandboxPath(projectRoot: string, fileName: string) {
  return `${projectRoot.replace(/\/+$/u, "")}/public/assets/${fileName}`;
}

function assetOutput(
  observation: AssetSuccessObservation,
  projectRoot: string,
) {
  const { status: _status, ...rest } = observation;
  return {
    ...rest,
    sandboxPath: assetSandboxPath(projectRoot, observation.fileName),
  };
}

function failureDiagnostic(
  assetId: string,
  failure: VideoSemanticFailureObservation,
) {
  return { assetId, code: failure.code, message: failure.message };
}

export function createGenerateVideoAssetsTool(input: {
  profile: AgentToolModelProfileView | null;
  execution?: AgentToolLlmExecutionConfig;
  traceId?: string;
  services: {
    modelGateway: AgentToolModelGatewayService<ImageGateway>;
    operationCache: AgentToolOperationCacheServices;
    sandbox: Required<AgentToolSandboxServices>;
    workBlobs: AgentToolWorkBlobServices;
  };
}) {
  return tool(
    async (args, runtime: ToolRuntime) => {
      if (!input.profile) {
        return videoToolBlocked({
          code: "VIDEO_IMAGE_PROFILE_UNAVAILABLE",
          message: "No configured image model profile is available.",
        });
      }
      const profile = input.profile;
      const toolCallId = resolveVideoToolCallId(runtime);
      const abortSignal = resolveVideoToolAbortSignal(runtime);
      if (
        new Set(args.assets.map((asset) => asset.assetId)).size !==
        args.assets.length
      ) {
        return videoToolBlocked({
          code: "VIDEO_ASSET_DUPLICATE_ID",
          message: "Each generated asset must have a unique assetId.",
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
        args.assets.map((asset) => {
          const semanticKey = sha256Digest(
            JSON.stringify({
              version: 2,
              provider: providerIdentity,
              prompt: asset.prompt,
              assetId: asset.assetId,
              type: asset.type,
            }),
          );
          return [semanticKey, asset] as const;
        }),
      );
      if (semanticByKey.size !== args.assets.length) {
        return videoToolBlocked({
          code: "VIDEO_ASSET_DUPLICATE_SEMANTICS",
          message: "The asset batch contains duplicate generation requests.",
        });
      }
      const claim = await input.services.operationCache.claimMany({
        toolName: GENERATE_VIDEO_ASSETS_TOOL_NAME,
        toolCallId,
        semanticKeys: [...semanticByKey.keys()],
        executionScope: "root_only",
      });
      if (claim.kind === "wait") {
        return videoToolBlocked({
          code: "VIDEO_ASSET_GENERATION_IN_PROGRESS",
          message: "An overlapping asset generation is already running.",
        });
      }
      if (claim.kind === "unknown") {
        return videoToolBlocked({
          code: claim.code,
          message: "A prior asset generation has an unknown provider outcome.",
        });
      }
      let clientPromise: ReturnType<
        typeof input.services.modelGateway.getClient
      > | null = null;
      const providerClient = () => {
        clientPromise ??= input.services.modelGateway.getClient({
          gatewayConfigId: profile.gatewayConfigId,
          feature: "artifact.video_presentation.asset",
        });
        return clientPromise;
      };
      const outputs: Array<ReturnType<typeof assetOutput>> = [];
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
            toolName: GENERATE_VIDEO_ASSETS_TOOL_NAME,
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
            toolName: GENERATE_VIDEO_ASSETS_TOOL_NAME,
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
            await markUnknown(item, "ASSET_FAILURE_OBSERVATION_UNKNOWN");
            return false;
          }
        }
      };

      for (const item of claim.items) {
        const request = semanticByKey.get(item.semanticKey);
        if (!request) {
          throw new Error("VIDEO_ASSET_CLAIM_IDENTITY_MISMATCH");
        }
        if (item.action === "reuse") {
          try {
            const cached = cachedAssetObservationSchema.parse(item.observation);
            if (cached.status === "failed") {
              diagnostics.push(failureDiagnostic(request.assetId, cached));
              continue;
            }
            if (cached.assetId !== request.assetId) {
              throw new Error("VIDEO_ASSET_CACHE_IDENTITY_MISMATCH");
            }
            const stored = await input.services.workBlobs.getVerified({
              blobRef: cached.blobRef,
              contentDigest: cached.contentDigest,
            });
            if (!stored) {
              throw new Error("VIDEO_ASSET_DURABLE_BYTES_MISSING");
            }
            const output = assetOutput(cached, args.projectRoot);
            await input.services.sandbox.uploadCurrentFiles(
              [{ path: output.sandboxPath, bytes: stored.bytes }],
              abortSignal ? { signal: abortSignal } : undefined,
            );
            outputs.push(output);
          } catch (error) {
            diagnostics.push({
              assetId: request.assetId,
              code:
                error instanceof Error
                  ? error.message.slice(0, 200)
                  : "VIDEO_ASSET_CACHE_RESTAGE_FAILED",
            });
          }
          continue;
        }

        let result: Awaited<
          ReturnType<
            Awaited<ReturnType<typeof providerClient>>["images"]["generate"]
          >
        >;
        let client: Awaited<ReturnType<typeof providerClient>>;
        try {
          client = await providerClient();
        } catch {
          if (abortSignal?.aborted) {
            await markPendingUnknown("ASSET_TOOL_ABORTED");
            throwVideoToolAbortReason(abortSignal);
          }
          const failure = videoSemanticFailure(
            "VIDEO_ASSET_PROVIDER_UNAVAILABLE",
            "The image provider is not configured for this request.",
          );
          if (await completeFailure(item, failure)) {
            diagnostics.push(failureDiagnostic(request.assetId, failure));
          } else {
            diagnostics.push({
              assetId: request.assetId,
              code: "VIDEO_ASSET_PROVIDER_OUTCOME_UNKNOWN",
            });
          }
          continue;
        }
        try {
          result = await client.images.generate(
            {
              ...gatewayExecution,
              prompt: request.prompt,
              count: 1,
              responseFormat: "b64_json",
            },
            {
              traceId: input.traceId,
              operation: "video.asset.generate",
              modelKind: "image",
              gatewayConfigId: profile.gatewayConfigId,
              profileAlias: profile.profileAlias,
              modelAlias: gatewayExecution.model,
              idempotencyKey: `video-asset:${item.semanticKey}`,
              ...(abortSignal ? { signal: abortSignal } : {}),
              llm: input.execution,
            },
          );
          throwVideoToolAbortReason(abortSignal);
        } catch (error) {
          if (abortSignal?.aborted) {
            await markPendingUnknown("ASSET_TOOL_ABORTED");
            throwVideoToolAbortReason(abortSignal);
          }
          const known = knownVideoProviderFailure({
            error,
            codePrefix: "VIDEO_ASSET",
            providerLabel: "image",
          });
          if (known && (await completeFailure(item, known))) {
            diagnostics.push(failureDiagnostic(request.assetId, known));
          } else {
            await markUnknown(item, "ASSET_PROVIDER_OUTCOME_UNKNOWN");
            diagnostics.push({
              assetId: request.assetId,
              code: "VIDEO_ASSET_PROVIDER_OUTCOME_UNKNOWN",
            });
          }
          continue;
        }

        const generated = result.images[0];
        const inlineFailure = !generated
          ? videoSemanticFailure(
              "VIDEO_ASSET_PROVIDER_RETURNED_NO_IMAGE",
              "The image provider returned no image.",
            )
          : !generated.b64Json
            ? videoSemanticFailure(
                "VIDEO_ASSET_INLINE_BYTES_REQUIRED",
                "The image provider did not return inline bytes.",
              )
            : null;
        if (inlineFailure) {
          if (await completeFailure(item, inlineFailure)) {
            diagnostics.push(failureDiagnostic(request.assetId, inlineFailure));
          } else {
            diagnostics.push({
              assetId: request.assetId,
              code: "VIDEO_ASSET_PROVIDER_OUTCOME_UNKNOWN",
            });
          }
          continue;
        }
        const decoded = decodeInlineImage(generated!);
        if (!decoded) {
          const failure = videoSemanticFailure(
            "VIDEO_ASSET_PROVIDER_RETURNED_EMPTY_IMAGE",
            "The image provider returned empty inline bytes.",
          );
          if (await completeFailure(item, failure)) {
            diagnostics.push(failureDiagnostic(request.assetId, failure));
          } else {
            diagnostics.push({
              assetId: request.assetId,
              code: "VIDEO_ASSET_PROVIDER_OUTCOME_UNKNOWN",
            });
          }
          continue;
        }
        const contentDigest = sha256Digest(decoded.bytes);
        const fileName = `${safeStorageSegment(request.assetId)}${imageExtensionForMimeType(decoded.contentType)}`;
        let stored: Awaited<
          ReturnType<typeof input.services.workBlobs.putIfAbsent>
        >;
        try {
          stored = await input.services.workBlobs.putIfAbsent({
            semanticKey: item.semanticKey,
            bytes: decoded.bytes,
            contentType: decoded.contentType,
            contentDigest,
            ttlSeconds: 24 * 60 * 60,
          });
        } catch {
          await markUnknown(item, "ASSET_DURABLE_BYTES_UNKNOWN");
          diagnostics.push({
            assetId: request.assetId,
            code: "VIDEO_ASSET_PROVIDER_OUTCOME_UNKNOWN",
          });
          continue;
        }
        const cached: AssetSuccessObservation = {
          status: "succeeded",
          assetId: request.assetId,
          blobRef: stored.blobRef,
          contentDigest,
          contentType: decoded.contentType,
          fileName,
          ...(generated!.width ? { width: generated!.width } : {}),
          ...(generated!.height ? { height: generated!.height } : {}),
          ...(result.provider ? { provider: result.provider } : {}),
          ...(result.providerModel
            ? { providerModel: result.providerModel }
            : {}),
        };
        try {
          try {
            await input.services.operationCache.complete({
              toolName: GENERATE_VIDEO_ASSETS_TOOL_NAME,
              semanticKey: item.semanticKey,
              claimToken: item.claimToken,
              observation: cached,
            });
          } catch {
            const durable = await input.services.workBlobs.getBySemanticKey({
              semanticKey: item.semanticKey,
            });
            if (!durable || durable.contentDigest !== contentDigest) {
              throw new Error("VIDEO_ASSET_OBSERVATION_COMMIT_UNKNOWN");
            }
            await input.services.operationCache.complete({
              toolName: GENERATE_VIDEO_ASSETS_TOOL_NAME,
              semanticKey: item.semanticKey,
              claimToken: item.claimToken,
              observation: cached,
            });
          }
          pendingExecuteItems.delete(item.semanticKey);
        } catch {
          await markUnknown(item, "ASSET_OBSERVATION_COMMIT_UNKNOWN");
          diagnostics.push({
            assetId: request.assetId,
            code: "VIDEO_ASSET_PROVIDER_OUTCOME_UNKNOWN",
          });
          continue;
        }
        const output = assetOutput(cached, args.projectRoot);
        try {
          await input.services.sandbox.uploadCurrentFiles(
            [{ path: output.sandboxPath, bytes: decoded.bytes }],
            abortSignal ? { signal: abortSignal } : undefined,
          );
          outputs.push(output);
        } catch {
          diagnostics.push({
            assetId: request.assetId,
            code: "VIDEO_ASSET_SANDBOX_RESTAGE_FAILED",
          });
        }
      }
      throwVideoToolAbortReason(abortSignal);
      return {
        status:
          diagnostics.length === 0
            ? ("succeeded" as const)
            : ("failed" as const),
        assets: outputs,
        diagnostics,
      };
    },
    {
      name: GENERATE_VIDEO_ASSETS_TOOL_NAME,
      description:
        "Generate a bounded batch of visual assets for the current video draft. Claims every semantic item before provider work and stages durable WIP bytes into the active sandbox without publishing standalone artifacts.",
      schema: generateVideoAssetsSchema,
    },
  );
}
