import { basename } from "node:path";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type {
  AgentToolCurrentRunArtifactPublicationServices,
  AgentToolOperationCacheServices,
  AgentToolReceiptServices,
  AgentToolSandboxServices,
  AgentToolWorkBlobServices,
} from "@sourceweft/contracts/agent-tools";
import type { ArtifactStorage } from "@sourceweft/contracts/artifact-storage";
import { buildArtifactRestUrl } from "@sourceweft/contracts/artifact-urls";
import {
  parseVideoPresentationDraftPayload,
  videoPresentationProjectPayloadSchema,
  type VideoPresentationDraftPayload,
} from "@sourceweft/contracts/video-presentation";
import { buildArtifactAssetUrl } from "../artifact-urls";
import { VIDEO_PRESENTATION_ARTIFACT_TYPE } from "../artifact-view";
import {
  draftToCommittedPayload,
  videoDraftResourceKey,
  type CommittedVideoResource,
} from "../pipeline/payload-mapping";
import { PUBLISH_VIDEO_PRESENTATION_TOOL_NAME } from "./agent-tool-defs";
import {
  resolveVideoToolAbortSignal,
  resolveVideoToolCallId,
  sha256Digest,
  throwVideoToolAbortReason,
  videoToolBlocked,
} from "./common";
import {
  buildVideoValidationInputDigest,
  type VideoValidationResourceBytes,
  VIDEO_PRESENTATION_LOAD_RECEIPT_SCHEMA_VERSION,
  VIDEO_PRESENTATION_VALIDATION_RECEIPT_SCHEMA_VERSION,
  VIDEO_PRESENTATION_VALIDATOR_VERSION,
} from "./validation-identity";

const publishVideoPresentationSchema = z
  .object({
    projectRoot: z.string().trim().min(1).max(1000),
    sourceJsonPath: z.string().trim().min(1).max(1000),
    validationReceiptId: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(180).optional(),
    prompt: z.string().trim().min(1).max(4000).optional(),
    edit: z
      .object({
        artifactId: z.string().trim().min(1).max(160),
        expectedVersionNo: z.number().int().min(1),
        loadReceiptId: z.string().trim().min(1).max(500),
      })
      .strict()
      .optional(),
  })
  .strict();

const projectCodeSchema =
  videoPresentationProjectPayloadSchema.shape.projectCode;

const validationReceiptSchema = z
  .object({
    projectRoot: z.string(),
    sourceJsonPath: z.string(),
    loadReceiptId: z.string().optional(),
    validationInputDigest: z.string(),
    projectClosureDigest: z.string(),
    validatorVersion: z.literal(VIDEO_PRESENTATION_VALIDATOR_VERSION),
    builderVersion: z.string(),
    projectCode: projectCodeSchema,
    measuredAudioTracks: z.array(
      z.object({
        slideNumber: z.number().int(),
        durationSeconds: z.number().positive(),
        mimeType: z.string().min(1),
      }),
    ),
    sampleDigests: z.array(z.record(z.string(), z.unknown())),
    renderPolicyVersion: z.string().min(1),
    rendererVersion: z.string().min(1),
    cover: z.object({
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
    }),
    renderedVideo: z.object({
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
      renderPolicyVersion: z.string().min(1),
      rendererVersion: z.string().min(1),
      timings: z.record(z.string(), z.number().nonnegative()),
    }),
  })
  .passthrough();

const loadReceiptSchema = z
  .object({
    artifactId: z.string(),
    versionId: z.string(),
    versionNo: z.number().int(),
    resourceAuthority: z.record(
      z.string(),
      z
        .object({
          kind: z.enum(["audio", "asset"]),
          slideNumber: z.number().int().optional(),
          assetId: z.string().optional(),
          storageKey: z.string(),
          storageBucket: z.string(),
          contentDigest: z.string(),
          contentType: z.string(),
          sandboxPath: z.string(),
          sourceUrl: z.string().optional(),
          fileName: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function relativePath(root: string, path: string) {
  const prefix = `${root.replace(/\/+$/u, "")}/`;
  if (!path.startsWith(prefix)) {
    throw new Error(`VIDEO_PUBLICATION_PATH_OUTSIDE_PROJECT: ${path}`);
  }
  return path.slice(prefix.length);
}

export function createPublishVideoPresentationTool(input: {
  workspaceId: string;
  services: {
    currentRunArtifacts: AgentToolCurrentRunArtifactPublicationServices;
    operationCache: AgentToolOperationCacheServices;
    receipts: AgentToolReceiptServices;
    sandbox: Required<AgentToolSandboxServices>;
    storage: ArtifactStorage;
    workBlobs: AgentToolWorkBlobServices;
  };
}) {
  return tool(
    async (args, runtime: ToolRuntime) => {
      const abortSignal = resolveVideoToolAbortSignal(runtime);
      throwVideoToolAbortReason(abortSignal);
      const toolCallId = resolveVideoToolCallId(runtime);
      const validationRaw =
        await input.services.receipts.resolveCurrentRunReceipt({
          receiptId: args.validationReceiptId,
          producerToolName: "validate_video_presentation",
          expectedSchemaVersion:
            VIDEO_PRESENTATION_VALIDATION_RECEIPT_SCHEMA_VERSION,
          executionScope: "root_only",
        });
      throwVideoToolAbortReason(abortSignal);
      const validation = validationReceiptSchema.safeParse(validationRaw);
      if (
        !validation.success ||
        validation.data.projectRoot !== args.projectRoot ||
        validation.data.sourceJsonPath !== args.sourceJsonPath ||
        validation.data.renderedVideo.renderPolicyVersion !==
          validation.data.renderPolicyVersion ||
        validation.data.renderedVideo.rendererVersion !==
          validation.data.rendererVersion
      ) {
        return videoToolBlocked({
          code: "VIDEO_VALIDATION_RECEIPT_INVALID",
          message:
            "The validation receipt is missing, stale, or for another project.",
        });
      }
      let loadReceipt: z.infer<typeof loadReceiptSchema> | null = null;
      if (args.edit) {
        const loadRaw = await input.services.receipts.resolveCurrentRunReceipt({
          receiptId: args.edit.loadReceiptId,
          producerToolName: "load_video_presentation",
          expectedSchemaVersion: VIDEO_PRESENTATION_LOAD_RECEIPT_SCHEMA_VERSION,
          executionScope: "root_only",
        });
        throwVideoToolAbortReason(abortSignal);
        const parsed = loadReceiptSchema.safeParse(loadRaw);
        if (
          !parsed.success ||
          parsed.data.artifactId !== args.edit.artifactId ||
          parsed.data.versionNo !== args.edit.expectedVersionNo ||
          validation.data.loadReceiptId !== args.edit.loadReceiptId
        ) {
          return videoToolBlocked({
            code: "VIDEO_EDIT_RECEIPT_INVALID",
            message: "The edit no longer matches the loaded artifact version.",
          });
        }
        loadReceipt = parsed.data;
      } else if (validation.data.loadReceiptId) {
        return videoToolBlocked({
          code: "VIDEO_CREATE_LOAD_RECEIPT_CONFLICT",
          message: "A loaded edit cannot be published as a new create.",
        });
      }
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
      const sourceRelative = relativePath(
        args.projectRoot,
        args.sourceJsonPath,
      );
      const sourceBytes = capturedByPath.get(sourceRelative);
      if (!sourceBytes) {
        return videoToolBlocked({
          code: "VIDEO_DRAFT_SOURCE_MISSING",
          message: "The validated draft source is missing.",
        });
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
              : String(error),
        });
      }
      if (draft.builderVersion !== validation.data.builderVersion) {
        return videoToolBlocked({
          code: "VIDEO_BUILDER_RECEIPT_MISMATCH",
          message: "The draft builder changed after validation.",
        });
      }
      const measuredAudioBySlide = new Map(
        validation.data.measuredAudioTracks.map((track) => [
          track.slideNumber,
          track,
        ]),
      );
      if (
        measuredAudioBySlide.size !== draft.audioTracks.length ||
        draft.audioTracks.some(
          (track) => !measuredAudioBySlide.has(track.slideNumber),
        )
      ) {
        return videoToolBlocked({
          code: "VIDEO_AUDIO_VALIDATION_RECEIPT_MISMATCH",
          message: "Measured narration evidence no longer matches the draft.",
        });
      }
      const publicationDraft: VideoPresentationDraftPayload = {
        ...draft,
        audioTracks: draft.audioTracks.map((track) => {
          const measured = measuredAudioBySlide.get(track.slideNumber)!;
          return {
            ...track,
            durationSeconds: measured.durationSeconds,
            mimeType: measured.mimeType,
          };
        }),
      };
      const resourcesWithBytes: Array<{
        kind: "audio" | "asset";
        identity: string;
        resource: VideoPresentationDraftPayload["audioTracks"][number]["resource"];
        bytes: Uint8Array;
        fileName: string;
        contentDigest: string;
        contentType: string;
      }> = [];
      for (const resource of [
        ...draft.audioTracks.map((track) => ({
          kind: "audio" as const,
          identity: String(track.slideNumber),
          resource: track.resource,
          fileName: track.fileName,
        })),
        ...draft.assets.map((asset) => ({
          kind: "asset" as const,
          identity: asset.assetId,
          resource: asset.resource,
          fileName:
            asset.resource.kind === "committed"
              ? basename(
                  loadReceipt?.resourceAuthority[asset.resource.resourceHandle]
                    ?.sandboxPath ?? "asset.bin",
                )
              : basename(asset.resource.sandboxPath),
        })),
      ]) {
        const authority =
          resource.resource.kind === "committed"
            ? loadReceipt?.resourceAuthority[resource.resource.resourceHandle]
            : null;
        const sandboxPath =
          resource.resource.kind === "committed"
            ? authority?.sandboxPath
            : resource.resource.sandboxPath;
        if (!sandboxPath) {
          return videoToolBlocked({
            code: "VIDEO_RESOURCE_AUTHORITY_MISSING",
            message:
              "A committed resource is not authorized by the load receipt.",
          });
        }
        if (
          authority &&
          (authority.kind !== resource.kind ||
            (resource.kind === "audio"
              ? authority.slideNumber !== Number(resource.identity)
              : authority.assetId !== resource.identity) ||
            authority.contentDigest !== resource.resource.contentDigest ||
            authority.contentType !== resource.resource.contentType)
        ) {
          return videoToolBlocked({
            code: "VIDEO_RESOURCE_RECEIPT_MISMATCH",
            message: `Protected resource authority changed for ${resource.kind} '${resource.identity}'.`,
          });
        }
        const relative = relativePath(args.projectRoot, sandboxPath);
        const bytes = capturedByPath.get(relative);
        if (
          !resource.resource.contentDigest ||
          !bytes ||
          sha256Digest(bytes) !== resource.resource.contentDigest
        ) {
          return videoToolBlocked({
            code: "VIDEO_RESOURCE_CHANGED_AFTER_VALIDATION",
            message: `A resource changed after validation: ${relative}`,
          });
        }
        resourcesWithBytes.push({
          ...resource,
          bytes,
          contentDigest: resource.resource.contentDigest,
          contentType: resource.resource.contentType,
        });
      }
      const validationResources: VideoValidationResourceBytes[] =
        resourcesWithBytes.map((resource) => ({
          identity:
            resource.kind === "audio"
              ? (`audio:${Number(resource.identity)}` as const)
              : (`asset:${resource.identity}` as const),
          bytes: resource.bytes,
        }));
      const validationInputDigest = buildVideoValidationInputDigest({
        draft,
        resources: validationResources,
      });
      if (validationInputDigest !== validation.data.validationInputDigest) {
        return videoToolBlocked({
          code: "VIDEO_DRAFT_CHANGED_AFTER_VALIDATION",
          message: "The draft or its resources changed after validation.",
        });
      }
      const publishSemanticKey = sha256Digest(
        JSON.stringify({
          version: 2,
          validationReceiptId: args.validationReceiptId,
          validationInputDigest,
          validatorVersion: validation.data.validatorVersion,
          renderPolicyVersion: validation.data.renderPolicyVersion,
          rendererVersion: validation.data.rendererVersion,
          projectClosureDigest: validation.data.projectClosureDigest,
          renderedVideoDigest: validation.data.renderedVideo.contentDigest,
          coverDigest: validation.data.cover.contentDigest,
          title: args.title ?? draft.project.title,
          prompt: args.prompt ?? draft.sourceDigest,
          edit: args.edit
            ? {
                artifactId: args.edit.artifactId,
                expectedVersionNo: args.edit.expectedVersionNo,
              }
            : null,
        }),
      );
      const claim = await input.services.operationCache.claimMany({
        toolName: PUBLISH_VIDEO_PRESENTATION_TOOL_NAME,
        toolCallId,
        semanticKeys: [publishSemanticKey],
        executionScope: "root_only",
      });
      if (claim.kind === "wait") {
        return videoToolBlocked({
          code: "VIDEO_PUBLICATION_IN_PROGRESS",
          message: "The validated project is already being published.",
        });
      }
      if (claim.kind === "unknown") {
        return videoToolBlocked({
          code: claim.code,
          message: "A prior publication has an unknown commit outcome.",
        });
      }
      const item = claim.items[0];
      if (!item) throw new Error("VIDEO_PUBLICATION_CLAIM_MISSING");
      if (item.action === "reuse") return item.observation;

      const completeBlocked = async (input: {
        code: string;
        message: string;
      }) => {
        const output = videoToolBlocked(input);
        try {
          await inputServices.operationCache.complete({
            toolName: PUBLISH_VIDEO_PRESENTATION_TOOL_NAME,
            semanticKey: publishSemanticKey,
            claimToken: item.claimToken,
            observation: output,
          });
        } catch {
          await inputServices.operationCache
            .markUnknown({
              toolName: PUBLISH_VIDEO_PRESENTATION_TOOL_NAME,
              semanticKey: publishSemanticKey,
              claimToken: item.claimToken,
              reason: "PUBLICATION_REJECTION_OBSERVATION_UNKNOWN",
            })
            .catch(() => undefined);
        }
        return output;
      };

      let preallocatedArtifactId: string | null = null;
      let publicationAttempted = false;
      let publicationRequest:
        | Parameters<
            AgentToolCurrentRunArtifactPublicationServices["publishCommitted"]
          >[0]
        | null = null;
      const inputServices = input.services;
      const uploadedKeys: string[] = [];
      const cleanupUploadedKeys = async () => {
        if (!input.services.storage.delete) return;
        await Promise.allSettled(
          uploadedKeys.map((key) => input.services.storage.delete!({ key })),
        );
      };
      const throwPublicationAbort = async (retainUploaded: boolean) => {
        if (!retainUploaded) {
          await cleanupUploadedKeys();
          if (preallocatedArtifactId) {
            await input.services.currentRunArtifacts
              .cleanupPreallocatedArtifact(preallocatedArtifactId)
              .catch(() => undefined);
          }
        }
        await input.services.operationCache
          .markUnknown({
            toolName: PUBLISH_VIDEO_PRESENTATION_TOOL_NAME,
            semanticKey: publishSemanticKey,
            claimToken: item.claimToken,
            reason: "PUBLICATION_TOOL_ABORTED",
          })
          .catch(() => undefined);
        throwVideoToolAbortReason(abortSignal);
        throw new Error("VIDEO_PUBLICATION_ABORT_REASON_MISSING");
      };
      type PublicationResult = Awaited<
        ReturnType<
          AgentToolCurrentRunArtifactPublicationServices["publishCommitted"]
        >
      >;
      const finishCommitted = async (
        committed: Extract<PublicationResult, { ok: true }>,
      ) => {
        if (
          preallocatedArtifactId &&
          committed.result.artifactId !== preallocatedArtifactId
        ) {
          await input.services.currentRunArtifacts
            .cleanupPreallocatedArtifact(preallocatedArtifactId)
            .catch(() => undefined);
        }
        const completePublicationObservation = () =>
          input.services.operationCache.complete({
            toolName: PUBLISH_VIDEO_PRESENTATION_TOOL_NAME,
            semanticKey: publishSemanticKey,
            claimToken: item.claimToken,
            observation: committed.result,
          });
        try {
          await completePublicationObservation();
        } catch {
          // Artifact/version + canonical tool output + card are already one
          // committed fact. Reconcile the identical cache observation once;
          // never downgrade or delete the committed publication if the cache
          // write remains unavailable.
          await completePublicationObservation().catch(() => undefined);
        }
        await input.services.workBlobs.deleteScope().catch(() => undefined);
        return committed.result;
      };
      const finishRejected = async (
        committed: Extract<PublicationResult, { ok: false }>,
      ) => {
        await cleanupUploadedKeys();
        if (preallocatedArtifactId) {
          await input.services.currentRunArtifacts
            .cleanupPreallocatedArtifact(preallocatedArtifactId)
            .catch(() => undefined);
        }
        return completeBlocked({
          code: `VIDEO_PUBLICATION_${committed.reason.toUpperCase()}`,
          message: `Publication was rejected: ${committed.reason}.`,
        });
      };
      const finishUnknown = async () => {
        await input.services.operationCache
          .markUnknown({
            toolName: PUBLISH_VIDEO_PRESENTATION_TOOL_NAME,
            semanticKey: publishSemanticKey,
            claimToken: item.claimToken,
            reason: "PUBLICATION_OUTCOME_UNKNOWN",
          })
          .catch(() => undefined);
        return videoToolBlocked({
          code: "VIDEO_PUBLICATION_OUTCOME_UNKNOWN",
          message:
            "Publication may have committed, but the host could not confirm the result. Uploaded objects were retained and must not be deleted.",
        });
      };
      try {
        throwVideoToolAbortReason(abortSignal);
        const artifactId =
          args.edit?.artifactId ??
          (() => {
            preallocatedArtifactId =
              input.services.currentRunArtifacts.allocateArtifactId();
            return preallocatedArtifactId;
          })();
        const committedResources = new Map<string, CommittedVideoResource>();
        for (const resource of resourcesWithBytes) {
          if (resource.resource.kind === "committed") {
            const authority =
              loadReceipt!.resourceAuthority[resource.resource.resourceHandle]!;
            committedResources.set(videoDraftResourceKey(resource.resource), {
              storageKey: authority.storageKey,
              storageBucket: authority.storageBucket,
              fileName: authority.fileName,
              assetUrl:
                resource.kind === "asset" && authority.sourceUrl
                  ? authority.sourceUrl
                  : buildArtifactAssetUrl({
                      workspaceId: input.workspaceId,
                      artifactId,
                      fileName:
                        resource.kind === "asset"
                          ? (authority.fileName ??
                            basename(authority.storageKey))
                          : resource.fileName,
                    }),
              contentDigest: authority.contentDigest,
              contentType: authority.contentType,
            });
            continue;
          }
          if (!resource.resource.blobRef) {
            throw new Error("VIDEO_LOCAL_RESOURCE_WIP_REF_MISSING");
          }
          const durable = await input.services.workBlobs.getVerified({
            blobRef: resource.resource.blobRef,
            contentDigest: resource.contentDigest,
          });
          throwVideoToolAbortReason(abortSignal);
          if (
            !durable ||
            sha256Digest(durable.bytes) !== sha256Digest(resource.bytes) ||
            durable.contentType !== resource.contentType
          ) {
            throw new Error("VIDEO_LOCAL_RESOURCE_WIP_MISMATCH");
          }
          const storageKey = input.services.storage.buildArtifactStorageKey({
            workspaceId: input.workspaceId,
            artifactId,
            fileName: resource.fileName,
          });
          uploadedKeys.push(storageKey);
          await input.services.storage.upload({
            key: storageKey,
            body: durable.bytes,
            contentType: durable.contentType,
            ...(abortSignal ? { signal: abortSignal } : {}),
          });
          throwVideoToolAbortReason(abortSignal);
          const servedFileName =
            resource.kind === "asset"
              ? basename(storageKey)
              : resource.fileName;
          committedResources.set(videoDraftResourceKey(resource.resource), {
            storageKey,
            storageBucket: input.services.storage.getBucketName(),
            fileName: servedFileName,
            assetUrl: buildArtifactAssetUrl({
              workspaceId: input.workspaceId,
              artifactId,
              fileName: servedFileName,
            }),
            contentDigest: resource.contentDigest,
            contentType: resource.contentType,
          });
        }
        const cover = await input.services.workBlobs.getVerified({
          blobRef: validation.data.cover.blobRef,
          contentDigest: validation.data.cover.contentDigest,
        });
        throwVideoToolAbortReason(abortSignal);
        if (
          !cover ||
          cover.contentType !== validation.data.cover.contentType ||
          cover.bytes.byteLength !== validation.data.cover.byteLength ||
          sha256Digest(cover.bytes) !== validation.data.cover.contentDigest
        ) {
          throw new Error("VIDEO_VALIDATED_COVER_MISSING");
        }
        const previewStorageKey =
          input.services.storage.buildArtifactStorageKey({
            workspaceId: input.workspaceId,
            artifactId,
            fileName: validation.data.cover.fileName,
          });
        uploadedKeys.push(previewStorageKey);
        await input.services.storage.upload({
          key: previewStorageKey,
          body: cover.bytes,
          contentType: cover.contentType,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        throwVideoToolAbortReason(abortSignal);
        const renderedVideo = await input.services.workBlobs.getVerified({
          blobRef: validation.data.renderedVideo.blobRef,
          contentDigest: validation.data.renderedVideo.contentDigest,
        });
        throwVideoToolAbortReason(abortSignal);
        if (
          !renderedVideo ||
          renderedVideo.contentType !==
            validation.data.renderedVideo.contentType ||
          renderedVideo.bytes.byteLength !==
            validation.data.renderedVideo.byteLength ||
          sha256Digest(renderedVideo.bytes) !==
            validation.data.renderedVideo.contentDigest
        ) {
          throw new Error("VIDEO_VALIDATED_MP4_MISSING");
        }
        const renderedVideoStorageKey =
          input.services.storage.buildArtifactStorageKey({
            workspaceId: input.workspaceId,
            artifactId,
            fileName: validation.data.renderedVideo.fileName,
          });
        uploadedKeys.push(renderedVideoStorageKey);
        await input.services.storage.upload({
          key: renderedVideoStorageKey,
          body: renderedVideo.bytes,
          contentType: renderedVideo.contentType,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        throwVideoToolAbortReason(abortSignal);
        const renderedVideoAssetUrl = buildArtifactAssetUrl({
          workspaceId: input.workspaceId,
          artifactId,
          fileName: validation.data.renderedVideo.fileName,
        });
        const coverImageAssetUrl = buildArtifactRestUrl({
          workspaceId: input.workspaceId,
          artifactId,
          resource: { kind: "previewImage" },
        });
        if (!renderedVideoAssetUrl || !coverImageAssetUrl) {
          throw new Error("VIDEO_COMMITTED_MEDIA_URL_INVALID");
        }
        const semanticRequestKey = `video:${sha256Digest(
          JSON.stringify({
            workflowVersion: publicationDraft.workflowVersion,
            builderVersion: publicationDraft.builderVersion,
            validatorVersion: validation.data.validatorVersion,
            renderPolicyVersion: validation.data.renderPolicyVersion,
            rendererVersion: validation.data.rendererVersion,
            validationInputDigest,
            projectClosureDigest: validation.data.projectClosureDigest,
            coverDigest: validation.data.cover.contentDigest,
            renderedVideoDigest: validation.data.renderedVideo.contentDigest,
            title: args.title ?? publicationDraft.project.title,
            prompt: args.prompt ?? publicationDraft.sourceDigest,
            resources: [...committedResources.entries()]
              .map(([key, resource]) => ({
                key,
                contentDigest: resource.contentDigest,
                contentType: resource.contentType,
              }))
              .sort((left, right) => left.key.localeCompare(right.key)),
          }),
        ).slice(7)}`;
        const payload = draftToCommittedPayload({
          draft: publicationDraft,
          resources: committedResources,
          requestKey: semanticRequestKey,
          projectCode: validation.data.projectCode,
          renderedVideo: {
            assetUrl: renderedVideoAssetUrl,
            storageKey: renderedVideoStorageKey,
            storageBucket: input.services.storage.getBucketName(),
            fileName: validation.data.renderedVideo.fileName,
            mimeType: validation.data.renderedVideo.contentType,
            byteLength: validation.data.renderedVideo.byteLength,
            contentDigest: validation.data.renderedVideo.contentDigest,
            durationInFrames: validation.data.renderedVideo.durationInFrames,
            fps: validation.data.renderedVideo.fps,
            width: validation.data.renderedVideo.width,
            height: validation.data.renderedVideo.height,
            hasAudio: validation.data.renderedVideo.hasAudio,
          },
          coverImage: {
            assetUrl: coverImageAssetUrl,
            storageKey: previewStorageKey,
            storageBucket: input.services.storage.getBucketName(),
            fileName: validation.data.cover.fileName,
            mimeType: validation.data.cover.contentType,
            byteLength: validation.data.cover.byteLength,
            contentDigest: validation.data.cover.contentDigest,
            width: validation.data.cover.width,
            height: validation.data.cover.height,
            slideNumber: validation.data.cover.slideNumber,
            metadata: validation.data.cover.metadata,
          },
          preview: {
            slideCount: publicationDraft.slides.length,
            durationSeconds: publicationDraft.project.durationSeconds,
          },
        });
        publicationRequest = {
          artifactType: VIDEO_PRESENTATION_ARTIFACT_TYPE,
          mode: args.edit
            ? {
                kind: "republish",
                artifactId,
                expectedVersionNo: args.edit.expectedVersionNo,
              }
            : { kind: "create", artifactId },
          payload,
          previewMetadata: validation.data.cover.metadata,
          previewStorageKey,
          prompt: args.prompt ?? publicationDraft.sourceDigest,
          semanticRequestKey,
          title: args.title ?? publicationDraft.project.title,
          workflowVersion: publicationDraft.workflowVersion,
        };
        throwVideoToolAbortReason(abortSignal);
        publicationAttempted = true;
        let committed: PublicationResult;
        let firstOutcomeUnknown = false;
        try {
          committed =
            await input.services.currentRunArtifacts.publishCommitted(
              publicationRequest,
            );
        } catch {
          firstOutcomeUnknown = true;
          if (abortSignal?.aborted) {
            return await throwPublicationAbort(true);
          }
          // A transport error can happen after the atomic publisher commits.
          // Retry once with the exact same root tool identity and semantic
          // request. The host publisher is idempotent for this identity.
          try {
            committed =
              await input.services.currentRunArtifacts.publishCommitted(
                publicationRequest,
              );
          } catch {
            return finishUnknown();
          }
        }
        if (!committed.ok) {
          return firstOutcomeUnknown
            ? finishUnknown()
            : finishRejected(committed);
        }
        return finishCommitted(committed);
      } catch {
        if (abortSignal?.aborted) {
          return await throwPublicationAbort(publicationAttempted);
        }
        if (!publicationAttempted) {
          await cleanupUploadedKeys();
          if (preallocatedArtifactId) {
            await input.services.currentRunArtifacts
              .cleanupPreallocatedArtifact(preallocatedArtifactId)
              .catch(() => undefined);
          }
          return completeBlocked({
            code: "VIDEO_PUBLICATION_PREPARE_FAILED",
            message:
              "Validated video resources could not be prepared for publication.",
          });
        }
        return finishUnknown();
      }
    },
    {
      name: PUBLISH_VIDEO_PRESENTATION_TOOL_NAME,
      description:
        "Atomically publish the exact validated current draft as the current video_presentation artifact version. Requires protected validation authority and returns a host-built committed artifact result.",
      schema: publishVideoPresentationSchema,
      returnDirect: true,
    },
  );
}
