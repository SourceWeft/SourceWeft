import { z } from "zod";

/** Shared with the artifacts table in @sourceweft/db. */
export const artifactTypeSchema = z.enum([
  "file",
  "report",
  "slides",
  "mindmap",
  "podcast",
  "audio_overview",
  "video_overview",
  "video_presentation",
  "flashcards",
  "quiz",
  "table",
  "infographic",
  "image",
]);

export const artifactStatusSchema = z.enum([
  "pending",
  "running",
  "ready",
  "failed",
  "archived",
]);

export const artifactCapabilitiesSchema = z.object({
  canOpenFile: z.boolean(),
  canDownloadFile: z.boolean(),
  canPreviewInline: z.boolean(),
  canRenderClientVideo: z.boolean(),
});

export const artifactSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  threadId: z.string().nullable(),
  artifactType: artifactTypeSchema,
  status: artifactStatusSchema,
  title: z.string().nullable(),
  promptText: z.string().nullable(),
  payloadJson: z.record(z.string(), z.unknown()),
  storageBucket: z.string().nullable(),
  storageKey: z.string().nullable(),
  previewStorageKey: z.string().nullable(),
  previewMetadataJson: z.record(z.string(), z.unknown()),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdBy: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  previewUrl: z.string().nullable(),
  capabilities: artifactCapabilitiesSchema,
});

export const listArtifactsResponseSchema = z.object({
  items: z.array(artifactSchema),
  nextCursor: z.string().nullable().optional(),
});

export const getArtifactResponseSchema = z.object({
  artifact: artifactSchema,
});

export type Artifact = z.infer<typeof artifactSchema>;
export type GetArtifactResponse = z.infer<typeof getArtifactResponseSchema>;
export type ListArtifactsResponse = z.infer<typeof listArtifactsResponseSchema>;
