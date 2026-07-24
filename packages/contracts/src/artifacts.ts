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
  /**
   * The client can render this artifact itself from its payload, rather than
   * needing a stored file to open or download. Which artifact types qualify is
   * answered by the capability that produces them, never by the host.
   */
  canRenderClientSide: z.boolean(),
});

/**
 * Read-side takeover contract for an artifact type.
 *
 * The host serves artifacts generically: a stored file, identified by its MIME
 * type, is opened, downloaded or previewed inline. That fallback covers most
 * artifacts and needs no per-type knowledge.
 *
 * A capability registers a view handler when the fallback does not apply —
 * typically because there is no single downloadable file and the client renders
 * the artifact from its payload instead. Registration *is* the declaration: the
 * host answers "can the client render this?" by looking up whether a handler
 * exists for the artifactType, and delegates payload-shaped questions (which
 * sub-assets exist under which names) to that handler. No artifact type names
 * ever reach the host.
 */
export type ArtifactViewRecord = {
  readonly artifactType: string;
  readonly status: string;
  readonly title: string | null;
  readonly storageBucket: string | null;
  readonly storageKey: string | null;
  readonly payloadJson: unknown;
};

export type ArtifactCapabilities = z.infer<typeof artifactCapabilitiesSchema>;

/** A byte stream the host can serve for an artifact (asset, attachment, …). */
export type ArtifactAssetLocation = {
  readonly contentType: string;
  readonly fileName: string;
  readonly storageBucket: string | null;
  readonly storageKey: string;
};

export type ArtifactViewHandler = {
  readonly artifactType: string;
  /** Resolve a sub-asset of the artifact by (already decoded) file name. */
  readonly resolveAsset?: (input: {
    readonly artifact: ArtifactViewRecord;
    readonly fileName: string;
  }) => ArtifactAssetLocation | null;
  /**
   * Download file name for the artifact's own stored file. Returning
   * null/undefined falls back to the host's generic naming (payload file name,
   * else the title).
   */
  readonly resolveFileName?: (input: {
    readonly artifact: ArtifactViewRecord;
  }) => string | null | undefined;
  /**
   * Content type for the artifact's own stored file. Returning null/undefined
   * falls back to the host's generic MIME resolution.
   */
  readonly resolveContentType?: (input: {
    readonly artifact: ArtifactViewRecord;
  }) => string | null | undefined;
  /**
   * Opaque renderer hint handed to the client when it opens the stored file.
   * Null/undefined means "no special renderer".
   */
  readonly resolveRenderer?: (input: {
    readonly artifact: ArtifactViewRecord;
  }) => string | null | undefined;
  /**
   * Whether the stored file can be previewed inline. Only consulted once the
   * host has established that a stored file exists; returning null/undefined
   * falls back to the host's MIME-based answer.
   */
  readonly canPreviewInline?: (input: {
    readonly artifact: ArtifactViewRecord;
    readonly contentType: string;
  }) => boolean | null | undefined;
};

/** Factory a capability package exports so hosts can collect its handlers. */
export type CreateArtifactViewHandlers = () =>
  | readonly ArtifactViewHandler[]
  | Promise<readonly ArtifactViewHandler[]>;

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
  visibility: z.enum(["private", "workspace"]),
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

export const deleteArtifactResponseSchema = z.object({
  deleted: z.literal(true),
  artifactId: z.string(),
});

export type Artifact = z.infer<typeof artifactSchema>;
export type GetArtifactResponse = z.infer<typeof getArtifactResponseSchema>;
export type ListArtifactsResponse = z.infer<typeof listArtifactsResponseSchema>;
export type DeleteArtifactResponse = z.infer<
  typeof deleteArtifactResponseSchema
>;
