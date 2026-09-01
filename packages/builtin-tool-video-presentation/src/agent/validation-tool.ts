import { basename } from "node:path";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { ModelGateway } from "@sourceweft/model-gateway";
import type {
  AgentToolModelGatewayService,
  AgentToolMediaServices,
  AgentToolLlmExecutionConfig,
  AgentToolModelProfileView,
  AgentToolOperationCacheServices,
  AgentToolReceiptServices,
  AgentToolSandboxServices,
  AgentToolWorkBlobServices,
} from "@sourceweft/contracts/agent-tools";
import {
  parseVideoPresentationDraftPayload,
  videoPresentationRenderableProjectSchema,
  type VideoPresentationDraftPayload,
} from "@sourceweft/contracts/video-presentation";
import { buildValidationProjectCodePayload } from "../pipeline/project-code";
import { validateCanonicalProjectTree } from "../pipeline/project-validation";
import { buildCoverFile } from "../pipeline/preview-images";
import { reviewStills } from "../visual-qa";
import { basicSceneCheck } from "../pipeline/scene-source";
import { lintSceneLayout } from "../scene-lint";
import {
  materializeVideoPresentationAssetUris,
  videoPresentationAssetUri,
} from "../pipeline/asset-uris";
import { VIDEO_PRESENTATION_NARRATION_TAIL_PADDING_SECONDS } from "@sourceweft/contracts/video-presentation";
import { resolveSynthesizedAudioMimeType } from "../pipeline/audio";
import { shellQuote } from "../pipeline/util";
import { sanitizeVideoPresentationFileBase } from "../video-presentation-files";
import { VALIDATE_VIDEO_PRESENTATION_TOOL_NAME } from "./agent-tool-defs";
import {
  VIDEO_PRESENTATION_BUILDER_VERSION,
  canonicalFileTreeDigest,
  knownVideoProviderFailure,
  resolveVideoGatewayExecution,
  resolveVideoToolAbortSignal,
  resolveVideoToolCallId,
  sha256Digest,
  throwVideoToolAbortReason,
  videoModelSemanticIdentity,
  videoToolBlocked,
} from "./common";
import {
  buildVideoValidationInputDigest,
  VIDEO_PRESENTATION_LOAD_RECEIPT_SCHEMA_VERSION,
  type VideoValidationResourceBytes,
  VIDEO_PRESENTATION_VALIDATION_RECEIPT_SCHEMA_VERSION,
  VIDEO_PRESENTATION_VALIDATOR_VERSION,
} from "./validation-identity";
import {
  VIDEO_PRESENTATION_RENDER_POLICY,
  VideoPresentationRenderError,
  createSandboxVideoPresentationRenderPort,
  type VideoPresentationRenderOutput,
  type VideoPresentationRenderPort,
  type VideoPresentationRenderedSample,
} from "./render-port";

type VisionGateway = Pick<ModelGateway, "chat">;

function duplicateValues(values: readonly (number | string)[]) {
  const seen = new Set<number | string>();
  const duplicates = new Set<number | string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function structuralDraftDiagnostics(draft: VideoPresentationDraftPayload) {
  const diagnostics: Array<Record<string, unknown>> = [];
  const slideNumbers = draft.slides.map((slide) => slide.slideNumber);
  const sceneNumbers = draft.sceneModules.map((scene) => scene.slideNumber);
  const slideNumberSet = new Set(slideNumbers);
  const assetIds = draft.assets.map((asset) => asset.assetId);
  const assetIdSet = new Set(assetIds);

  const duplicateSlides = duplicateValues(slideNumbers);
  const duplicateScenes = duplicateValues(sceneNumbers);
  const duplicateAssets = duplicateValues(assetIds);
  if (duplicateSlides.length > 0) {
    diagnostics.push({ code: "VIDEO_SLIDE_NUMBER_DUPLICATE", duplicateSlides });
  }
  if (duplicateScenes.length > 0) {
    diagnostics.push({ code: "VIDEO_SCENE_NUMBER_DUPLICATE", duplicateScenes });
  }
  if (duplicateAssets.length > 0) {
    diagnostics.push({ code: "VIDEO_ASSET_ID_DUPLICATE", duplicateAssets });
  }

  const expectedSlideNumbers = Array.from(
    { length: draft.slides.length },
    (_, index) => index + 1,
  );
  if (slideNumbers.join(",") !== expectedSlideNumbers.join(",")) {
    diagnostics.push({
      code: "VIDEO_SLIDE_SEQUENCE_INVALID",
      actual: [...new Set(slideNumbers)].sort((left, right) => left - right),
      expected: expectedSlideNumbers,
    });
  }

  const missingScenes = slideNumbers.filter(
    (slideNumber) => !sceneNumbers.includes(slideNumber),
  );
  const orphanScenes = sceneNumbers.filter(
    (slideNumber) => !slideNumberSet.has(slideNumber),
  );
  if (
    missingScenes.length > 0 ||
    orphanScenes.length > 0 ||
    sceneNumbers.join(",") !== expectedSlideNumbers.join(",")
  ) {
    diagnostics.push({
      code: "VIDEO_SCENE_COVERAGE_INVALID",
      missingScenes,
      orphanScenes,
      actualOrder: sceneNumbers,
      expectedOrder: expectedSlideNumbers,
    });
  }

  for (const slide of draft.slides) {
    const duplicateRefs = duplicateValues(
      slide.assetRefs.map((reference) => reference.assetId),
    );
    const unknownRefs = slide.assetRefs
      .map((reference) => reference.assetId)
      .filter((assetId) => !assetIdSet.has(assetId));
    if (duplicateRefs.length > 0 || unknownRefs.length > 0) {
      diagnostics.push({
        code: "VIDEO_SLIDE_ASSET_REFS_INVALID",
        slideNumber: slide.slideNumber,
        duplicateRefs,
        unknownRefs,
      });
    }
  }
  for (const asset of draft.assets) {
    const duplicateSlideRefs = duplicateValues(asset.slideNumbers);
    const unknownSlides = asset.slideNumbers.filter(
      (slideNumber) => !slideNumberSet.has(slideNumber),
    );
    const missingReverseRefs = asset.slideNumbers.filter((slideNumber) => {
      const slide = draft.slides.find(
        (candidate) => candidate.slideNumber === slideNumber,
      );
      return !slide?.assetRefs.some(
        (reference) => reference.assetId === asset.assetId,
      );
    });
    if (
      duplicateSlideRefs.length > 0 ||
      unknownSlides.length > 0 ||
      missingReverseRefs.length > 0
    ) {
      diagnostics.push({
        code: "VIDEO_ASSET_SLIDE_REFS_INVALID",
        assetId: asset.assetId,
        duplicateSlideRefs,
        unknownSlides,
        missingReverseRefs,
      });
    }
  }

  const duplicateThemes = duplicateValues(
    draft.themeAssignments.map((assignment) => assignment.slideNumber),
  );
  const orphanThemes = draft.themeAssignments
    .map((assignment) => assignment.slideNumber)
    .filter((slideNumber) => !slideNumberSet.has(slideNumber));
  if (duplicateThemes.length > 0 || orphanThemes.length > 0) {
    diagnostics.push({
      code: "VIDEO_THEME_ASSIGNMENTS_INVALID",
      duplicateThemes,
      orphanThemes,
    });
  }

  const durationFromScenes =
    draft.sceneModules.reduce(
      (total, scene) => total + scene.durationInFrames,
      0,
    ) / draft.project.fps;
  const durationTolerance = 1 / draft.project.fps;
  if (
    Math.abs(draft.project.durationSeconds - durationFromScenes) >
    durationTolerance
  ) {
    diagnostics.push({
      code: "VIDEO_TIMELINE_DURATION_MISMATCH",
      declaredDurationSeconds: draft.project.durationSeconds,
      measuredDurationSeconds: durationFromScenes,
    });
  }
  return diagnostics;
}

const validateVideoPresentationSchema = z
  .object({
    projectRoot: z.string().trim().min(1).max(1000),
    sourceJsonPath: z.string().trim().min(1).max(1000),
    loadReceiptId: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const loadReceiptPayloadSchema = z
  .object({
    artifactId: z.string(),
    versionId: z.string(),
    versionNo: z.number().int(),
    projectRoot: z.string(),
    sourceJsonPath: z.string(),
    projectClosureDigest: z.string(),
    sourceDigest: z.string(),
    resourceAuthority: z.record(
      z.string(),
      z
        .object({
          kind: z.enum(["audio", "asset"]),
          storageKey: z.string(),
          storageBucket: z.string().nullish(),
          contentDigest: z.string(),
          contentType: z.string(),
          sandboxPath: z.string(),
          sourceUrl: z.string().optional(),
          fileName: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const validationOutputSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("passed"),
      validationInputDigest: z.string(),
      validationReceiptId: z.string(),
      previewImagePath: z.string(),
      previewImageDigest: z.string(),
      renderedVideoDigest: z.string(),
      renderedVideoByteLength: z.number().int().positive(),
      projectClosureDigest: z.string(),
      visualChecked: z.boolean(),
      validatorVersion: z.literal(VIDEO_PRESENTATION_VALIDATOR_VERSION),
      renderPolicyVersion: z.literal(VIDEO_PRESENTATION_RENDER_POLICY.version),
      warnings: z.array(z.string()),
      diagnostics: z.array(z.never()).max(0),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      validationInputDigest: z.string(),
      validatorVersion: z.literal(VIDEO_PRESENTATION_VALIDATOR_VERSION),
      diagnostics: z.array(z.record(z.string(), z.unknown())).min(1),
    })
    .strict(),
]);

const validationReceiptWipSchema = z
  .object({
    validationInputDigest: z.string(),
    validatorVersion: z.literal(VIDEO_PRESENTATION_VALIDATOR_VERSION),
    renderPolicyVersion: z.literal(VIDEO_PRESENTATION_RENDER_POLICY.version),
    cover: z
      .object({
        blobRef: z.string(),
        contentDigest: z.string(),
        contentType: z.literal("image/jpeg"),
        fileName: z.string(),
        byteLength: z.number().int().positive(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        slideNumber: z.number().int().positive(),
        metadata: z.record(z.string(), z.unknown()),
        previewImagePath: z.string(),
      })
      .passthrough(),
    renderedVideo: z
      .object({
        blobRef: z.string(),
        contentDigest: z.string(),
        contentType: z.literal("video/mp4"),
        fileName: z.string(),
        byteLength: z.number().int().positive(),
        durationInFrames: z.number().int().positive(),
        fps: z.number().int().positive(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        hasAudio: z.boolean(),
        renderPolicyVersion: z.literal(
          VIDEO_PRESENTATION_RENDER_POLICY.version,
        ),
        rendererVersion: z.string(),
        timings: z.record(z.string(), z.number().nonnegative()),
      })
      .passthrough(),
  })
  .passthrough();

function relativePath(root: string, absolutePath: string) {
  const prefix = `${root.replace(/\/+$/u, "")}/`;
  if (!absolutePath.startsWith(prefix)) {
    throw new Error(`VIDEO_VALIDATION_PATH_OUTSIDE_PROJECT: ${absolutePath}`);
  }
  return absolutePath.slice(prefix.length);
}

function dataUrl(bytes: Uint8Array, mimeType: string) {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function resultText(raw: unknown) {
  return raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "content" in raw &&
    typeof raw.content === "string"
    ? raw.content
    : "";
}

export function createValidateVideoPresentationTool(input: {
  profile: AgentToolModelProfileView | null;
  execution?: AgentToolLlmExecutionConfig;
  traceId?: string;
  renderPort?: VideoPresentationRenderPort;
  services: {
    modelGateway: AgentToolModelGatewayService<VisionGateway>;
    media: AgentToolMediaServices;
    operationCache: AgentToolOperationCacheServices;
    receipts: AgentToolReceiptServices;
    sandbox: Required<AgentToolSandboxServices>;
    workBlobs: AgentToolWorkBlobServices;
  };
}) {
  const resolveRenderPort = () =>
    input.renderPort ??
    createSandboxVideoPresentationRenderPort({
      sandbox: input.services.sandbox,
    });
  return tool(
    async (args, runtime: ToolRuntime) => {
      const profile = input.profile;
      const toolCallId = resolveVideoToolCallId(runtime);
      const abortSignal = resolveVideoToolAbortSignal(runtime);
      const captured = await input.services.sandbox.captureCurrentTree({
        root: args.projectRoot,
        maxFiles: 200,
        maxTotalBytes: 25 * 1024 * 1024,
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
      throwVideoToolAbortReason(abortSignal);
      const capturedByPath = new Map(
        captured.map((file) => [file.relativePath, file.bytes]),
      );
      const sourceRelativePath = relativePath(
        args.projectRoot,
        args.sourceJsonPath,
      );
      const sourceBytes = capturedByPath.get(sourceRelativePath);
      if (!sourceBytes) {
        return videoToolBlocked({
          code: "VIDEO_DRAFT_SOURCE_MISSING",
          message: "The canonical draft source JSON is missing.",
        });
      }
      let loadReceipt: z.infer<typeof loadReceiptPayloadSchema> | null = null;
      if (args.loadReceiptId) {
        const resolved = await input.services.receipts.resolveCurrentRunReceipt(
          {
            receiptId: args.loadReceiptId,
            producerToolName: "load_video_presentation",
            expectedSchemaVersion:
              VIDEO_PRESENTATION_LOAD_RECEIPT_SCHEMA_VERSION,
            executionScope: "root_only",
          },
        );
        const parsed = loadReceiptPayloadSchema.safeParse(resolved);
        if (!parsed.success) {
          return videoToolBlocked({
            code: "VIDEO_LOAD_RECEIPT_INVALID",
            message: "The edit load receipt is missing, stale, or invalid.",
          });
        }
        loadReceipt = parsed.data;
      }
      let draft: VideoPresentationDraftPayload;
      try {
        draft = parseVideoPresentationDraftPayload(
          JSON.parse(new TextDecoder().decode(sourceBytes)),
          loadReceipt
            ? {
                mode: "edit",
                authorizedResourceHandles: new Set(
                  Object.keys(loadReceipt.resourceAuthority),
                ),
              }
            : { mode: "create" },
        );
      } catch (error) {
        return videoToolBlocked({
          code: "VIDEO_DRAFT_INVALID",
          message:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "The draft is invalid.",
        });
      }
      if (draft.builderVersion !== VIDEO_PRESENTATION_BUILDER_VERSION) {
        return videoToolBlocked({
          code: "VIDEO_BUILDER_VERSION_UNSUPPORTED",
          message: `Unsupported video builder '${draft.builderVersion}'.`,
        });
      }
      const structuralDiagnostics = structuralDraftDiagnostics(draft);
      if (structuralDiagnostics.length > 0) {
        return videoToolBlocked({
          code: "VIDEO_DRAFT_STRUCTURE_INVALID",
          message: "Slides, scenes, assets, or timeline are inconsistent.",
          diagnostics: structuralDiagnostics,
        });
      }
      const allowedImageUrls = draft.assets.map((asset) =>
        videoPresentationAssetUri(asset.assetId),
      );
      const sceneDiagnostics: Array<Record<string, unknown>> = [];
      for (const scene of draft.sceneModules) {
        const basic = basicSceneCheck(scene.code);
        const layout = lintSceneLayout(
          scene.code,
          { width: draft.project.width, height: draft.project.height },
          { allowedImageUrls },
        );
        if (basic.length > 0 || layout.errors.length > 0) {
          sceneDiagnostics.push({
            code: "VIDEO_SCENE_STATIC_SAFETY_FAILED",
            slideNumber: scene.slideNumber,
            diagnostics: basic,
            layoutErrors: layout.errors,
            layoutWarnings: layout.warnings,
          });
        }
      }
      if (sceneDiagnostics.length > 0) {
        return videoToolBlocked({
          code: "VIDEO_SCENE_STATIC_SAFETY_FAILED",
          message: "Scene code failed static source safety checks.",
          diagnostics: sceneDiagnostics,
        });
      }
      const validationResources: VideoValidationResourceBytes[] = [];
      for (const track of draft.audioTracks) {
        const resource = track.resource;
        const authority =
          resource.kind === "committed"
            ? loadReceipt?.resourceAuthority[resource.resourceHandle]
            : null;
        if (
          authority &&
          (authority.kind !== "audio" ||
            authority.slideNumber !== track.slideNumber ||
            authority.contentDigest !== resource.contentDigest ||
            authority.contentType !== resource.contentType)
        ) {
          return videoToolBlocked({
            code: "VIDEO_AUDIO_RECEIPT_MISMATCH",
            message: `Narration authority does not match slide ${track.slideNumber}.`,
          });
        }
        const sourcePath =
          resource.kind === "committed"
            ? authority?.sandboxPath
            : resource.sandboxPath;
        if (!sourcePath) {
          return videoToolBlocked({
            code: "VIDEO_RESOURCE_AUTHORITY_MISSING",
            message: "A draft resource is not authorized by the load receipt.",
          });
        }
        const relative = relativePath(args.projectRoot, sourcePath);
        const bytes = capturedByPath.get(relative);
        if (!bytes || sha256Digest(bytes) !== resource.contentDigest) {
          return videoToolBlocked({
            code: "VIDEO_AUDIO_DIGEST_MISMATCH",
            message: `Narration bytes do not match slide ${track.slideNumber}.`,
          });
        }
        validationResources.push({
          identity: `audio:${track.slideNumber}`,
          bytes,
        });
      }
      for (const asset of draft.assets) {
        const resource = asset.resource;
        const authority =
          resource.kind === "committed"
            ? loadReceipt?.resourceAuthority[resource.resourceHandle]
            : null;
        if (
          authority &&
          (authority.kind !== "asset" ||
            authority.assetId !== asset.assetId ||
            authority.contentDigest !== resource.contentDigest ||
            authority.contentType !== resource.contentType)
        ) {
          return videoToolBlocked({
            code: "VIDEO_ASSET_RECEIPT_MISMATCH",
            message: `Asset authority does not match '${asset.assetId}'.`,
          });
        }
        const sourcePath =
          resource.kind === "committed"
            ? authority?.sandboxPath
            : resource.sandboxPath;
        if (!sourcePath) {
          return videoToolBlocked({
            code: "VIDEO_RESOURCE_AUTHORITY_MISSING",
            message: `Asset authority is missing for '${asset.assetId}'.`,
          });
        }
        const relative = relativePath(args.projectRoot, sourcePath);
        const bytes = capturedByPath.get(relative);
        if (!bytes || sha256Digest(bytes) !== resource.contentDigest) {
          return videoToolBlocked({
            code: "VIDEO_ASSET_DIGEST_MISMATCH",
            message: `Asset bytes do not match '${asset.assetId}'.`,
          });
        }
        validationResources.push({ identity: `asset:${asset.assetId}`, bytes });
      }
      const validationInputDigest = buildVideoValidationInputDigest({
        draft,
        resources: validationResources,
      });
      const sandboxSession =
        await input.services.sandbox.ensureCurrentSession();
      const semanticKey = sha256Digest(
        JSON.stringify({
          version: 1,
          validationInputDigest,
          validatorVersion: VIDEO_PRESENTATION_VALIDATOR_VERSION,
          builderVersion: draft.builderVersion,
          rendererVersion: VIDEO_PRESENTATION_RENDER_POLICY.rendererVersion,
          renderPolicyVersion: VIDEO_PRESENTATION_RENDER_POLICY.version,
          renderHostLimits: sandboxSession.hostLimits ?? null,
          sandboxGeneration: sandboxSession.sessionGeneration,
          loadArtifactId: loadReceipt?.artifactId ?? null,
          loadVersionId: loadReceipt?.versionId ?? null,
          visionModel: profile
            ? videoModelSemanticIdentity(profile, input.execution)
            : null,
        }),
      );
      const claim = await input.services.operationCache.claimMany({
        toolName: VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
        toolCallId,
        semanticKeys: [semanticKey],
        executionScope: "root_only",
      });
      if (claim.kind === "wait") {
        return videoToolBlocked({
          code: "VIDEO_VALIDATION_IN_PROGRESS",
          message: "The exact same project is already being validated.",
        });
      }
      if (claim.kind === "unknown") {
        return videoToolBlocked({
          code: claim.code,
          message: "A prior validation has an unknown external outcome.",
        });
      }
      const item = claim.items[0];
      if (!item) throw new Error("VIDEO_VALIDATION_CLAIM_MISSING");
      if (item.action === "reuse") {
        const cachedOutput = validationOutputSchema.safeParse(item.observation);
        if (!cachedOutput.success) {
          return videoToolBlocked({
            code: "VIDEO_VALIDATION_CACHE_INTEGRITY_FAILED",
            message: "The completed validation observation is malformed.",
          });
        }
        if (cachedOutput.data.status === "passed") {
          const cachedReceiptRaw =
            await input.services.receipts.resolveCurrentRunReceipt({
              receiptId: cachedOutput.data.validationReceiptId,
              producerToolName: VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
              expectedSchemaVersion:
                VIDEO_PRESENTATION_VALIDATION_RECEIPT_SCHEMA_VERSION,
              executionScope: "root_only",
            });
          const cachedReceipt =
            validationReceiptWipSchema.safeParse(cachedReceiptRaw);
          if (
            !cachedReceipt.success ||
            cachedReceipt.data.validationInputDigest !==
              validationInputDigest ||
            cachedReceipt.data.renderedVideo.contentDigest !==
              cachedOutput.data.renderedVideoDigest
          ) {
            return videoToolBlocked({
              code: "VIDEO_VALIDATION_CACHE_INTEGRITY_FAILED",
              message:
                "The completed validation receipt is missing or does not match the cached result.",
            });
          }
          const [cover, renderedVideo] = await Promise.all([
            input.services.workBlobs.getVerified({
              blobRef: cachedReceipt.data.cover.blobRef,
              contentDigest: cachedReceipt.data.cover.contentDigest,
            }),
            input.services.workBlobs.getVerified({
              blobRef: cachedReceipt.data.renderedVideo.blobRef,
              contentDigest: cachedReceipt.data.renderedVideo.contentDigest,
            }),
          ]);
          if (
            !cover ||
            cover.contentType !== cachedReceipt.data.cover.contentType ||
            sha256Digest(cover.bytes) !==
              cachedReceipt.data.cover.contentDigest ||
            !renderedVideo ||
            renderedVideo.contentType !==
              cachedReceipt.data.renderedVideo.contentType ||
            sha256Digest(renderedVideo.bytes) !==
              cachedReceipt.data.renderedVideo.contentDigest
          ) {
            return videoToolBlocked({
              code: "VIDEO_VALIDATION_CACHE_INTEGRITY_FAILED",
              message:
                "The completed validation media is missing or failed integrity verification.",
            });
          }
        }
        return cachedOutput.data;
      }

      const fail = async (diagnostics: Array<Record<string, unknown>>) => {
        const output = validationOutputSchema.parse({
          status: "failed",
          validationInputDigest,
          validatorVersion: VIDEO_PRESENTATION_VALIDATOR_VERSION,
          diagnostics,
        });
        try {
          await input.services.operationCache.complete({
            toolName: VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
            semanticKey,
            claimToken: item.claimToken,
            observation: output,
          });
        } catch {
          await input.services.operationCache
            .markUnknown({
              toolName: VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
              semanticKey,
              claimToken: item.claimToken,
              reason: "VALIDATION_OBSERVATION_UNKNOWN",
            })
            .catch(() => undefined);
        }
        return output;
      };
      const markUnknown = async (reason: string) => {
        await input.services.operationCache
          .markUnknown({
            toolName: VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
            semanticKey,
            claimToken: item.claimToken,
            reason,
          })
          .catch(() => undefined);
        return videoToolBlocked({
          code: "SIDE_EFFECT_OUTCOME_UNKNOWN",
          message:
            "The visual validation provider outcome is unknown; the host will not repeat it blindly.",
        });
      };

      try {
        const canonicalResources: Array<{
          path: string;
          bytes: Uint8Array;
        }> = [];
        const audioTracks = [] as Array<{
          slideNumber: number;
          assetUrl: string;
          storageKey: string;
          storageBucket: string;
          durationSeconds: number;
          mimeType: string;
          contentDigest: string;
          contentType: string;
          fileName: string;
        }>;
        for (const track of draft.audioTracks) {
          const authority =
            track.resource.kind === "committed"
              ? loadReceipt?.resourceAuthority[track.resource.resourceHandle]
              : null;
          const sourcePath =
            track.resource.kind === "committed"
              ? authority?.sandboxPath
              : track.resource.sandboxPath;
          if (!sourcePath) {
            return fail([
              {
                code: "VIDEO_AUDIO_AUTHORITY_MISSING",
                slideNumber: track.slideNumber,
              },
            ]);
          }
          if (
            authority &&
            (authority.contentDigest !== track.resource.contentDigest ||
              authority.contentType !== track.resource.contentType)
          ) {
            return fail([
              {
                code: "VIDEO_AUDIO_RECEIPT_MISMATCH",
                slideNumber: track.slideNumber,
              },
            ]);
          }
          const bytes = capturedByPath.get(
            relativePath(args.projectRoot, sourcePath),
          );
          if (!bytes || sha256Digest(bytes) !== track.resource.contentDigest) {
            return fail([
              {
                code: "VIDEO_AUDIO_DIGEST_MISMATCH",
                slideNumber: track.slideNumber,
              },
            ]);
          }
          if (track.resource.kind === "local") {
            if (!track.resource.blobRef) {
              return fail([
                {
                  code: "VIDEO_AUDIO_WIP_REF_MISSING",
                  slideNumber: track.slideNumber,
                },
              ]);
            }
            const durable = await input.services.workBlobs.getVerified({
              blobRef: track.resource.blobRef,
              contentDigest: track.resource.contentDigest,
            });
            if (
              !durable ||
              sha256Digest(durable.bytes) !== sha256Digest(bytes)
            ) {
              return fail([
                {
                  code: "VIDEO_AUDIO_WIP_MISMATCH",
                  slideNumber: track.slideNumber,
                },
              ]);
            }
          }
          const measuredMimeType = resolveSynthesizedAudioMimeType({
            audio: bytes,
            mimeType: track.mimeType,
          });
          const measuredDurationSeconds =
            await input.services.media.probeAudioDurationSeconds({
              bytes,
              mimeType: measuredMimeType,
            });
          const durationTolerance = measuredDurationSeconds
            ? Math.max(0.25, measuredDurationSeconds * 0.05)
            : 0;
          const scene = draft.sceneModules.find(
            (candidate) => candidate.slideNumber === track.slideNumber,
          );
          if (
            !measuredDurationSeconds ||
            Math.abs(measuredDurationSeconds - track.durationSeconds) >
              durationTolerance ||
            !scene ||
            scene.durationInFrames <
              Math.ceil(
                (measuredDurationSeconds +
                  VIDEO_PRESENTATION_NARRATION_TAIL_PADDING_SECONDS) *
                  draft.project.fps,
              )
          ) {
            return fail([
              {
                code: "VIDEO_AUDIO_MEASUREMENT_MISMATCH",
                slideNumber: track.slideNumber,
                declaredDurationSeconds: track.durationSeconds,
                measuredDurationSeconds,
              },
            ]);
          }
          canonicalResources.push({
            path: `public/audio/${track.fileName}`,
            bytes,
          });
          audioTracks.push({
            slideNumber: track.slideNumber,
            assetUrl: `/audio/${track.fileName}`,
            storageKey: `validation/audio/${track.fileName}`,
            storageBucket: "validation",
            durationSeconds: measuredDurationSeconds,
            mimeType: measuredMimeType,
            contentDigest: track.resource.contentDigest,
            contentType: measuredMimeType,
            fileName: track.fileName,
          });
        }
        const assets = [] as Array<Record<string, unknown>>;
        for (const asset of draft.assets) {
          const authority =
            asset.resource.kind === "committed"
              ? loadReceipt?.resourceAuthority[asset.resource.resourceHandle]
              : null;
          const sourcePath =
            asset.resource.kind === "committed"
              ? authority?.sandboxPath
              : asset.resource.sandboxPath;
          if (!sourcePath) {
            return fail([
              { code: "VIDEO_ASSET_AUTHORITY_MISSING", assetId: asset.assetId },
            ]);
          }
          if (
            authority &&
            (authority.contentDigest !== asset.resource.contentDigest ||
              authority.contentType !== asset.resource.contentType)
          ) {
            return fail([
              { code: "VIDEO_ASSET_RECEIPT_MISMATCH", assetId: asset.assetId },
            ]);
          }
          const bytes = capturedByPath.get(
            relativePath(args.projectRoot, sourcePath),
          );
          if (!bytes || sha256Digest(bytes) !== asset.resource.contentDigest) {
            return fail([
              { code: "VIDEO_ASSET_DIGEST_MISMATCH", assetId: asset.assetId },
            ]);
          }
          if (asset.resource.kind === "local") {
            if (!asset.resource.blobRef) {
              return fail([
                { code: "VIDEO_ASSET_WIP_REF_MISSING", assetId: asset.assetId },
              ]);
            }
            const durable = await input.services.workBlobs.getVerified({
              blobRef: asset.resource.blobRef,
              contentDigest: asset.resource.contentDigest,
            });
            if (
              !durable ||
              sha256Digest(durable.bytes) !== sha256Digest(bytes)
            ) {
              return fail([
                { code: "VIDEO_ASSET_WIP_MISMATCH", assetId: asset.assetId },
              ]);
            }
          }
          const fileName = basename(sourcePath);
          canonicalResources.push({ path: `public/assets/${fileName}`, bytes });
          assets.push({
            assetId: asset.assetId,
            type: asset.type,
            prompt: asset.prompt,
            fileName,
            storageKey: `validation/assets/${fileName}`,
            storageBucket: "validation",
            sourceUrl: `/public/assets/${fileName}`,
            contentDigest: asset.resource.contentDigest,
            contentType: asset.resource.contentType,
            slideNumbers: asset.slideNumbers,
            source: asset.source,
          });
        }
        const validationPayload =
          videoPresentationRenderableProjectSchema.parse({
            narrationPolicy: draft.narrationPolicy,
            project: draft.project,
            slides: draft.slides,
            audioTracks,
            sceneModules: draft.sceneModules,
            assets,
            preview: {
              slideCount: draft.slides.length,
              durationSeconds: draft.project.durationSeconds,
            },
            renderProfile: draft.renderProfile,
            themeAssignments: draft.themeAssignments,
            sourceDigest: draft.sourceDigest,
          });
        const narrationFiles = audioTracks.map((track) => ({
          slideNumber: track.slideNumber,
          fileName: track.fileName,
          durationSeconds: track.durationSeconds,
        }));
        const built = buildValidationProjectCodePayload(
          materializeVideoPresentationAssetUris(validationPayload),
          {
            ...(narrationFiles.length > 0 ? { narrationFiles } : {}),
          },
        );
        const canonicalRoot = `/workspace/.sourceweft-video-validation/${validationInputDigest.slice(7, 31)}`;
        const canonicalFiles = [
          ...built.files.map((file) => ({
            path: `${canonicalRoot}/${file.path}`,
            bytes: new TextEncoder().encode(file.content),
          })),
          ...canonicalResources.map((file) => ({
            path: `${canonicalRoot}/${file.path}`,
            bytes: file.bytes,
          })),
        ];
        await input.services.sandbox.uploadCurrentFiles(
          canonicalFiles,
          abortSignal ? { signal: abortSignal } : undefined,
        );
        throwVideoToolAbortReason(abortSignal);
        const execute = (command: string) =>
          input.services.sandbox.executeCurrent({
            command: `cd ${shellQuote(canonicalRoot)} && ${command}`,
            timeoutMs: VIDEO_PRESENTATION_RENDER_POLICY.commandTimeoutMs,
            ...(abortSignal ? { signal: abortSignal } : {}),
          });
        const projectCode = await validateCanonicalProjectTree({ execute });
        if (
          !projectCode.install.ok ||
          !projectCode.typecheck.ok ||
          !projectCode.smoke.ok
        ) {
          return fail([
            {
              code: "VIDEO_PROJECT_VALIDATION_FAILED",
              install: projectCode.install,
              typecheck: projectCode.typecheck,
              smoke: projectCode.smoke,
            },
          ]);
        }
        const renderSession = await resolveRenderPort().prepare({
          canonicalRoot,
          project: {
            durationInFrames: draft.sceneModules.reduce(
              (total, scene) => total + scene.durationInFrames,
              0,
            ),
            fps: draft.project.fps,
            width: draft.project.width,
            height: draft.project.height,
            narrationEnabled: draft.narrationPolicy.enabled,
            scenes: draft.sceneModules.map((scene) => ({
              slideNumber: scene.slideNumber,
              durationInFrames: scene.durationInFrames,
            })),
          },
          samples: built.validationSamples,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        let renderedSamples: readonly VideoPresentationRenderedSample[] = [];
        let finalRender: VideoPresentationRenderOutput | null = null;
        let cover: ReturnType<typeof buildCoverFile> = null;
        let visualChecked = false;
        const warnings: string[] = [];
        try {
          renderedSamples = await renderSession.renderSamples();
          if (renderedSamples.length !== built.validationSamples.length) {
            return fail([{ code: "VIDEO_RUNTIME_SAMPLE_FAILED" }]);
          }
          const middleStills = renderedSamples
            .filter((sample) => sample.sampleId === "middle")
            .map((sample) => ({
              slideNumber: sample.slideNumber,
              data: sample.data,
              mimeType: "image/jpeg",
            }));
          if (profile) {
            let review: Awaited<ReturnType<typeof reviewStills>>;
            try {
              const vision = await input.services.modelGateway.getClient({
                gatewayConfigId: profile.gatewayConfigId,
                feature: "artifact.video_presentation.validation",
              });
              let visionCall = 0;
              review = await reviewStills({
                stills: middleStills,
                canvas: {
                  width: draft.project.width,
                  height: draft.project.height,
                },
                batchSize: 4,
                metadata: { validationInputDigest },
                completeVision: async (reviewInput) => {
                  visionCall += 1;
                  const result = await vision.chat.complete(
                    {
                      ...resolveVideoGatewayExecution(profile, input.execution),
                      messages: [
                        {
                          role: "user",
                          content: [
                            { type: "text", text: reviewInput.prompt },
                            ...reviewInput.images.map((image) => ({
                              type: "image_url" as const,
                              image_url: {
                                url: dataUrl(image.data, image.mimeType),
                              },
                            })),
                          ],
                        },
                      ],
                      maxTokens: 1800,
                      temperature: 0,
                    },
                    {
                      traceId: input.traceId,
                      operation: "video.validation.vision",
                      modelKind: "vision",
                      gatewayConfigId: profile.gatewayConfigId,
                      profileAlias: profile.profileAlias,
                      modelAlias: profile.modelAlias,
                      idempotencyKey: `video-validation:${semanticKey}:vision:${visionCall}`,
                      ...(abortSignal ? { signal: abortSignal } : {}),
                      llm: input.execution,
                    },
                  );
                  throwVideoToolAbortReason(abortSignal);
                  return resultText(result.raw);
                },
              });
            } catch (error) {
              throwVideoToolAbortReason(abortSignal);
              const known = knownVideoProviderFailure({
                error,
                codePrefix: "VIDEO_VALIDATION",
                providerLabel: "visual validation",
              });
              if (known) {
                return fail([{ code: known.code, message: known.message }]);
              }
              return markUnknown("VISUAL_VALIDATION_OUTCOME_UNKNOWN");
            }
            const verdictBySlide = new Map(
              review.verdicts.map((verdict) => [verdict.slideNumber, verdict]),
            );
            const rejectedSlides = draft.slides.filter((slide) => {
              const verdict = verdictBySlide.get(slide.slideNumber);
              return !verdict || !verdict.ok || verdict.issues.length > 0;
            });
            if (
              review.unparseableBatches.length > 0 ||
              rejectedSlides.length > 0
            ) {
              return fail([
                {
                  code: "VIDEO_VISUAL_REVIEW_FAILED",
                  unparseableBatches: review.unparseableBatches,
                  rejectedSlides: rejectedSlides.map(
                    (slide) => slide.slideNumber,
                  ),
                  verdicts: review.verdicts,
                },
              ]);
            }
            visualChecked = true;
          } else {
            warnings.push("VIDEO_VISUAL_REVIEW_SKIPPED_NO_PROFILE");
          }
          cover = buildCoverFile({
            payload: validationPayload,
            stills: middleStills,
          });
          if (!cover) {
            return fail([{ code: "VIDEO_COVER_REQUIRED" }]);
          }
          finalRender = await renderSession.renderFinal();
        } finally {
          await renderSession.dispose();
        }
        if (!cover || !finalRender) {
          return fail([{ code: "VIDEO_RENDER_REQUIRED" }]);
        }
        const coverDigest = sha256Digest(cover.data);
        const coverWip = await input.services.workBlobs.putIfAbsent({
          semanticKey: `validation-cover:${semanticKey}`,
          bytes: cover.data,
          contentType: cover.contentType,
          contentDigest: coverDigest,
          ttlSeconds: 24 * 60 * 60,
        });
        const renderedVideoWip = await input.services.workBlobs.putIfAbsent({
          semanticKey: `validation-video:${semanticKey}`,
          bytes: finalRender.bytes,
          contentType: finalRender.report.mimeType,
          contentDigest: finalRender.report.contentDigest,
          ttlSeconds: 24 * 60 * 60,
        });
        if (
          coverWip.contentDigest !== coverDigest ||
          renderedVideoWip.contentDigest !== finalRender.report.contentDigest
        ) {
          return fail([{ code: "VIDEO_VALIDATION_WIP_INTEGRITY_FAILED" }]);
        }
        const projectClosureDigest = canonicalFileTreeDigest(canonicalFiles);
        const receipt = await input.services.receipts.issueCurrentRunReceipt({
          producerToolName: VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
          producerToolCallId: toolCallId,
          schemaVersion: VIDEO_PRESENTATION_VALIDATION_RECEIPT_SCHEMA_VERSION,
          payload: {
            projectRoot: args.projectRoot,
            sourceJsonPath: args.sourceJsonPath,
            loadReceiptId: args.loadReceiptId,
            validationInputDigest,
            projectClosureDigest,
            validatorVersion: VIDEO_PRESENTATION_VALIDATOR_VERSION,
            builderVersion: draft.builderVersion,
            renderPolicyVersion: finalRender.report.renderPolicyVersion,
            rendererVersion: finalRender.report.rendererVersion,
            visualChecked,
            warnings,
            projectCode,
            measuredAudioTracks: audioTracks.map((track) => ({
              slideNumber: track.slideNumber,
              durationSeconds: track.durationSeconds,
              mimeType: track.mimeType,
            })),
            sampleDigests: renderedSamples.map((sample) => ({
              slideNumber: sample.slideNumber,
              sampleId: sample.sampleId,
              digest: sha256Digest(sample.data),
            })),
            cover: {
              blobRef: coverWip.blobRef,
              contentDigest: coverDigest,
              contentType: cover.contentType,
              fileName: cover.fileName,
              byteLength: cover.data.byteLength,
              width: draft.project.width,
              height: draft.project.height,
              slideNumber: cover.slideNumber,
              metadata: cover.metadata,
              previewImagePath: `${canonicalRoot}/${built.validationSamples.find((sample) => sample.slideNumber === cover.slideNumber && sample.sampleId === "middle")!.relativePath}`,
            },
            renderedVideo: {
              blobRef: renderedVideoWip.blobRef,
              contentDigest: finalRender.report.contentDigest,
              contentType: finalRender.report.mimeType,
              fileName: `${sanitizeVideoPresentationFileBase(draft.project.title)}.mp4`,
              byteLength: finalRender.report.byteLength,
              durationInFrames: finalRender.report.durationInFrames,
              fps: finalRender.report.fps,
              width: finalRender.report.width,
              height: finalRender.report.height,
              hasAudio: finalRender.report.hasAudio,
              renderPolicyVersion: finalRender.report.renderPolicyVersion,
              rendererVersion: finalRender.report.rendererVersion,
              timings: finalRender.timings,
            },
          },
        });
        const output = validationOutputSchema.parse({
          status: "passed",
          validationInputDigest,
          validationReceiptId: receipt.receiptId,
          previewImagePath: `${canonicalRoot}/${built.validationSamples.find((sample) => sample.slideNumber === cover.slideNumber && sample.sampleId === "middle")!.relativePath}`,
          previewImageDigest: coverDigest,
          renderedVideoDigest: finalRender.report.contentDigest,
          renderedVideoByteLength: finalRender.report.byteLength,
          projectClosureDigest,
          visualChecked,
          validatorVersion: VIDEO_PRESENTATION_VALIDATOR_VERSION,
          renderPolicyVersion: finalRender.report.renderPolicyVersion,
          warnings,
          diagnostics: [],
        });
        const completePassedObservation = () =>
          input.services.operationCache.complete({
            toolName: VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
            semanticKey,
            claimToken: item.claimToken,
            observation: output,
          });
        try {
          await completePassedObservation();
        } catch {
          // The receipt is already durable. Retrying the identical fenced
          // observation reconciles a commit-before-response failure without
          // re-running sandbox or vision work.
          await completePassedObservation();
        }
        return output;
      } catch (error) {
        if (
          error instanceof VideoPresentationRenderError &&
          error.code === "SANDBOX_TERMINATION_UNKNOWN"
        ) {
          // An unconfirmed remote termination is host control flow, not a
          // deterministic validation result that may be cached and retried.
          throw error;
        }
        if (abortSignal?.aborted) {
          await markUnknown("VALIDATION_TOOL_ABORTED");
          throwVideoToolAbortReason(abortSignal);
        }
        if (error instanceof VideoPresentationRenderError) {
          return fail([error.toDiagnostic()]);
        }
        return fail([
          {
            code: "VIDEO_VALIDATION_EXECUTION_FAILED",
            message:
              error instanceof Error
                ? error.message.slice(0, 500)
                : String(error),
          },
        ]);
      }
    },
    {
      name: VALIDATE_VIDEO_PRESENTATION_TOOL_NAME,
      description:
        "Freeze and validate the exact draft: trusted resource closure, build/typecheck/smoke, one prepared bundle, begin/middle/end runtime samples, optional configured vision review, required cover, and required sandbox-rendered MP4. Only a passed protected receipt can be published.",
      schema: validateVideoPresentationSchema,
    },
  );
}
