import { basename } from "node:path";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type {
  AgentToolArtifactVersionServices,
  AgentToolOperationCacheServices,
  AgentToolReceiptServices,
  AgentToolSandboxServices,
} from "@sourceweft/contracts/agent-tools";
import type { ArtifactStorage } from "@sourceweft/contracts/artifact-storage";
import {
  VIDEO_PRESENTATION_WORKFLOW_VERSION,
  videoPresentationDraftPayloadSchema,
  videoPresentationProjectPayloadSchema,
  type VideoPresentationDraftPayload,
  type VideoPresentationProjectPayload,
} from "@sourceweft/contracts/video-presentation";
import { buildProjectCodePayload } from "../pipeline/project-code";
import { VIDEO_PRESENTATION_ARTIFACT_TYPE } from "../artifact-view";
import {
  VIDEO_PRESENTATION_BUILDER_VERSION,
  VIDEO_PRESENTATION_SOURCE_FILE,
  canonicalFileTreeDigest,
  resolveVideoToolAbortSignal,
  resolveVideoToolCallId,
  sha256Digest,
  throwVideoToolAbortReason,
  videoToolBlocked,
} from "./common";
import { LOAD_VIDEO_PRESENTATION_TOOL_NAME } from "./tool-names";
import { VIDEO_PRESENTATION_LOAD_RECEIPT_SCHEMA_VERSION } from "./validation-identity";

export { LOAD_VIDEO_PRESENTATION_TOOL_NAME } from "./tool-names";

const loadVideoPresentationSchema = z
  .object({ artifactId: z.string().trim().min(1).max(160) })
  .strict();

type LoadToolServices = {
  artifactVersions: AgentToolArtifactVersionServices;
  operationCache: AgentToolOperationCacheServices;
  receipts: AgentToolReceiptServices;
  sandbox: Required<AgentToolSandboxServices>;
  storage: ArtifactStorage;
};

function assertArtifactStorageKey(input: {
  artifactId: string;
  workspaceId: string;
  storageKey: string;
}) {
  const prefix = `workspaces/${input.workspaceId}/artifacts/${input.artifactId}/`;
  if (!input.storageKey.startsWith(prefix)) {
    throw new Error(
      "VIDEO_PRESENTATION_RESOURCE_SCOPE_INVALID: resource is outside the authorized artifact prefix",
    );
  }
}

function parseCommittedPayload(
  payload: unknown,
): VideoPresentationProjectPayload {
  return videoPresentationProjectPayloadSchema.parse(payload);
}

function assertAuthorizedStorageBucket(input: {
  configuredBucket: string;
  storageBucket: string;
}) {
  if (input.storageBucket !== input.configuredBucket) {
    throw new Error(
      "VIDEO_PRESENTATION_RESOURCE_BUCKET_INVALID: resource bucket is not authorized",
    );
  }
}

function resourceHandle(input: {
  versionId: string;
  kind: "audio" | "asset";
  identity: string;
  storageKey: string;
}) {
  return `resource_${sha256Digest(
    `${input.versionId}\0${input.kind}\0${input.identity}\0${input.storageKey}`,
  ).slice(7, 47)}`;
}

function stableLoadFailure(error: unknown) {
  const raw = error instanceof Error ? error.message : "";
  const known = [
    "VIDEO_PRESENTATION_RESOURCE_INTEGRITY_FAILED",
    "VIDEO_PRESENTATION_RESOURCE_MISSING",
    "VIDEO_PRESENTATION_RESOURCE_SCOPE_INVALID",
    "VIDEO_PRESENTATION_RESOURCE_BUCKET_INVALID",
  ].find((code) => raw.startsWith(code));
  if (known) {
    return videoToolBlocked({
      code: known,
      message:
        known === "VIDEO_PRESENTATION_RESOURCE_INTEGRITY_FAILED"
          ? "A committed video resource no longer matches its validated digest or content type."
          : "A committed video resource is unavailable or outside its authorized scope.",
      diagnostics: [{ code: known, stage: "load_resource" }],
    });
  }
  if (error instanceof z.ZodError) {
    return videoToolBlocked({
      code: "VIDEO_PRESENTATION_COMMITTED_PAYLOAD_INVALID",
      message: "The committed video project does not match the current schema.",
      diagnostics: [
        {
          code: "VIDEO_PRESENTATION_COMMITTED_PAYLOAD_INVALID",
          stage: "parse_committed_project",
        },
      ],
    });
  }
  const sandboxCode = raw.match(/\bSANDBOX_[A-Z0-9_]+\b/u)?.[0];
  if (sandboxCode) {
    return videoToolBlocked({
      code: "VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE",
      message: "The active sandbox could not materialize the video project.",
      diagnostics: [
        {
          code: "VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE",
          stage: "stage_project",
          sandboxCode,
        },
      ],
    });
  }
  return videoToolBlocked({
    code: "VIDEO_PRESENTATION_LOAD_FAILED",
    message:
      "The authorized video version could not be materialized in the active sandbox.",
    diagnostics: [
      { code: "VIDEO_PRESENTATION_LOAD_FAILED", stage: "load_project" },
    ],
  });
}

export function createLoadVideoPresentationTool(input: {
  workspaceId: string;
  services: LoadToolServices;
}) {
  return tool(
    async (args, runtime: ToolRuntime) => {
      const abortSignal = resolveVideoToolAbortSignal(runtime);
      throwVideoToolAbortReason(abortSignal);
      const toolCallId = resolveVideoToolCallId(runtime);
      const current =
        await input.services.artifactVersions.readAuthorizedCurrentVersion({
          artifactId: args.artifactId,
          expectedArtifactType: VIDEO_PRESENTATION_ARTIFACT_TYPE,
        });
      if (!current) {
        return videoToolBlocked({
          code: "VIDEO_PRESENTATION_NOT_FOUND",
          message: "The current ready video presentation is unavailable.",
        });
      }
      const session = await input.services.sandbox.ensureCurrentSession();
      const semanticKey = [
        "load-video-presentation",
        current.artifactId,
        current.versionId,
        session.sessionGeneration,
      ].join(":");
      const claim = await input.services.operationCache.claimMany({
        toolName: LOAD_VIDEO_PRESENTATION_TOOL_NAME,
        toolCallId,
        semanticKeys: [semanticKey],
        executionScope: "root_only",
      });
      if (claim.kind === "wait") {
        return videoToolBlocked({
          code: "VIDEO_PRESENTATION_LOAD_IN_PROGRESS",
          message: "The same version is already being loaded in this sandbox.",
        });
      }
      if (claim.kind === "unknown") {
        return videoToolBlocked({
          code: claim.code,
          message: "A prior load has an unknown side-effect outcome.",
        });
      }
      const claimedItem = claim.items[0];
      if (!claimedItem) {
        throw new Error("VIDEO_PRESENTATION_LOAD_CLAIM_MISSING");
      }
      if (claimedItem.action === "reuse") {
        return claimedItem.observation;
      }

      try {
        const committed = parseCommittedPayload(current.payload);
        const configuredBucket = input.services.storage.getBucketName();
        const projectRoot = `/workspace/video-presentation-${current.artifactId}-${current.versionNo}`;
        const resourceAuthority: Record<string, Record<string, unknown>> = {};
        const uploadedResources: Array<{
          path: string;
          bytes: Uint8Array;
        }> = [];

        const audioTracks = [] as VideoPresentationDraftPayload["audioTracks"];
        for (const track of committed.audioTracks) {
          assertAuthorizedStorageBucket({
            configuredBucket,
            storageBucket: track.storageBucket,
          });
          assertArtifactStorageKey({
            artifactId: current.artifactId,
            workspaceId: input.workspaceId,
            storageKey: track.storageKey,
          });
          const stored = await input.services.storage.download({
            key: track.storageKey,
            bucket: track.storageBucket,
          });
          if (!stored || stored.body.byteLength === 0) {
            throw new Error(
              `VIDEO_PRESENTATION_RESOURCE_MISSING: narration ${track.slideNumber}`,
            );
          }
          if (
            sha256Digest(stored.body) !== track.contentDigest ||
            stored.contentType !== track.contentType
          ) {
            throw new Error(
              `VIDEO_PRESENTATION_RESOURCE_INTEGRITY_FAILED: narration ${track.slideNumber}`,
            );
          }
          const handle = resourceHandle({
            versionId: current.versionId,
            kind: "audio",
            identity: String(track.slideNumber),
            storageKey: track.storageKey,
          });
          const sandboxPath = `${projectRoot}/public/audio/${track.fileName}`;
          const contentDigest = track.contentDigest;
          uploadedResources.push({ path: sandboxPath, bytes: stored.body });
          resourceAuthority[handle] = {
            kind: "audio",
            slideNumber: track.slideNumber,
            storageKey: track.storageKey,
            storageBucket: track.storageBucket,
            contentDigest,
            contentType: track.contentType,
            fileName: track.fileName,
            sandboxPath,
          };
          audioTracks.push({
            slideNumber: track.slideNumber,
            durationSeconds: track.durationSeconds,
            mimeType: track.mimeType,
            fileName: track.fileName,
            resource: {
              kind: "committed",
              resourceHandle: handle,
              contentDigest,
              contentType: track.contentType,
            },
          });
        }

        const assets = [] as VideoPresentationDraftPayload["assets"];
        for (const asset of committed.assets) {
          assertAuthorizedStorageBucket({
            configuredBucket,
            storageBucket: asset.storageBucket,
          });
          assertArtifactStorageKey({
            artifactId: current.artifactId,
            workspaceId: input.workspaceId,
            storageKey: asset.storageKey,
          });
          const stored = await input.services.storage.download({
            key: asset.storageKey,
            bucket: asset.storageBucket,
          });
          if (!stored || stored.body.byteLength === 0) {
            throw new Error(
              `VIDEO_PRESENTATION_RESOURCE_MISSING: asset ${asset.assetId}`,
            );
          }
          if (
            sha256Digest(stored.body) !== asset.contentDigest ||
            stored.contentType !== asset.contentType
          ) {
            throw new Error(
              `VIDEO_PRESENTATION_RESOURCE_INTEGRITY_FAILED: asset ${asset.assetId}`,
            );
          }
          const handle = resourceHandle({
            versionId: current.versionId,
            kind: "asset",
            identity: asset.assetId,
            storageKey: asset.storageKey,
          });
          const fileName = basename(asset.storageKey);
          const sandboxPath = `${projectRoot}/public/assets/${fileName}`;
          const contentDigest = asset.contentDigest;
          uploadedResources.push({ path: sandboxPath, bytes: stored.body });
          resourceAuthority[handle] = {
            kind: "asset",
            assetId: asset.assetId,
            fileName,
            sourceUrl: asset.sourceUrl,
            storageKey: asset.storageKey,
            storageBucket: asset.storageBucket,
            contentDigest,
            contentType: asset.contentType,
            sandboxPath,
          };
          assets.push({
            assetId: asset.assetId,
            type: asset.type,
            prompt: asset.prompt,
            slideNumbers: asset.slideNumbers,
            source: asset.source,
            resource: {
              kind: "committed",
              resourceHandle: handle,
              contentDigest,
              contentType: asset.contentType,
            },
          });
        }

        const draft = videoPresentationDraftPayloadSchema.parse({
          schemaVersion: 1,
          kind: "video_presentation_draft",
          workflowVersion: VIDEO_PRESENTATION_WORKFLOW_VERSION,
          builderVersion: VIDEO_PRESENTATION_BUILDER_VERSION,
          narrationPolicy: committed.narrationPolicy,
          renderProfile: committed.renderProfile,
          sourceDigest: committed.sourceDigest,
          project: committed.project,
          slides: committed.slides,
          sceneModules: committed.sceneModules,
          audioTracks,
          assets,
          themeAssignments: committed.themeAssignments,
        });
        const sourceJsonPath = `${projectRoot}/${VIDEO_PRESENTATION_SOURCE_FILE}`;
        const sourceBytes = new TextEncoder().encode(
          JSON.stringify(draft, null, 2),
        );
        const projectCode = buildProjectCodePayload({
          ...committed,
        });
        const projectFiles = projectCode.files.map((file) => ({
          path: `${projectRoot}/${file.path}`,
          bytes: new TextEncoder().encode(file.content),
        }));
        const files = [
          ...projectFiles,
          ...uploadedResources,
          { path: sourceJsonPath, bytes: sourceBytes },
        ];
        await input.services.sandbox.uploadCurrentFiles(
          files,
          abortSignal ? { signal: abortSignal } : undefined,
        );
        throwVideoToolAbortReason(abortSignal);
        const projectClosureDigest = canonicalFileTreeDigest(files);
        const receipt = await input.services.receipts.issueCurrentRunReceipt({
          producerToolName: LOAD_VIDEO_PRESENTATION_TOOL_NAME,
          producerToolCallId: toolCallId,
          schemaVersion: VIDEO_PRESENTATION_LOAD_RECEIPT_SCHEMA_VERSION,
          payload: {
            artifactId: current.artifactId,
            versionId: current.versionId,
            versionNo: current.versionNo,
            projectRoot,
            sourceJsonPath,
            projectClosureDigest,
            sourceDigest: draft.sourceDigest,
            resourceAuthority,
          },
        });
        const output = {
          status: "succeeded" as const,
          artifactId: current.artifactId,
          versionId: current.versionId,
          versionNo: current.versionNo,
          projectRoot,
          sourceJsonPath,
          projectClosureDigest,
          sourceDigest: draft.sourceDigest,
          loadReceiptId: receipt.receiptId,
          diagnostics: [],
        };
        await input.services.operationCache.complete({
          toolName: LOAD_VIDEO_PRESENTATION_TOOL_NAME,
          semanticKey,
          claimToken: claimedItem.claimToken,
          observation: output,
        });
        return output;
      } catch (error) {
        if (abortSignal?.aborted) {
          await input.services.operationCache
            .markUnknown({
              toolName: LOAD_VIDEO_PRESENTATION_TOOL_NAME,
              semanticKey,
              claimToken: claimedItem.claimToken,
              reason: "LOAD_TOOL_ABORTED",
            })
            .catch(() => undefined);
          throwVideoToolAbortReason(abortSignal);
        }
        const output = stableLoadFailure(error);
        try {
          await input.services.operationCache.complete({
            toolName: LOAD_VIDEO_PRESENTATION_TOOL_NAME,
            semanticKey,
            claimToken: claimedItem.claimToken,
            observation: output,
          });
        } catch {
          await input.services.operationCache
            .markUnknown({
              toolName: LOAD_VIDEO_PRESENTATION_TOOL_NAME,
              semanticKey,
              claimToken: claimedItem.claimToken,
              reason: "LOAD_FAILURE_OBSERVATION_UNKNOWN",
            })
            .catch(() => undefined);
        }
        return output;
      }
    },
    {
      name: LOAD_VIDEO_PRESENTATION_TOOL_NAME,
      description:
        "Load the current authorized ready video presentation into the active sandbox for an exact edit. Returns only sandbox paths, digests, and opaque receipt/resource authority.",
      schema: loadVideoPresentationSchema,
    },
  );
}
