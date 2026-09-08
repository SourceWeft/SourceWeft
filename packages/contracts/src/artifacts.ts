import { z } from "zod";
import type { ArtifactExecutionPolicy } from "./artifact-execution";

/** Shared with the artifacts table in @sourceweft/db. */
export const artifactTypeSchema = z.enum([
  "file",
  "html",
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

export type ArtifactStoredObjectLocation = {
  readonly storageBucket: string | null;
  readonly storageKey: string;
};

/**
 * Trusted, immutable media resolved from one artifact version's content JSON.
 * Storage coordinates stay inside the backend; only the safe projection below
 * crosses into Web code.
 */
export type ArtifactVersionMediaAssetLocation = ArtifactAssetLocation & {
  readonly byteLength: number;
  readonly contentDigest: string;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly hasAudio?: boolean;
};

export type ArtifactVersionMedia = {
  readonly title: string;
  readonly description?: string | null;
  readonly durationSeconds?: number | null;
  readonly media: ArtifactVersionMediaAssetLocation;
  readonly coverImage?: ArtifactVersionMediaAssetLocation | null;
};

export type ArtifactViewHandler = {
  readonly artifactType: string;
  /** Trusted file policy supplied by the registered format, never by the producer. */
  readonly executionPolicy?: ArtifactExecutionPolicy;
  /** Resolve browser-playable media from this exact payload version. */
  readonly resolveVersionMedia?: (input: {
    readonly artifact: ArtifactViewRecord;
  }) => ArtifactVersionMedia | null;
  /** Enumerate immutable objects owned by this exact payload for deletion. */
  readonly listOwnedStorageObjects?: (input: {
    readonly artifact: ArtifactViewRecord;
  }) => readonly ArtifactStoredObjectLocation[];
  /** Resolve a sub-asset of the artifact by (already decoded) file name. */
  readonly resolveAsset?: (input: {
    readonly artifact: ArtifactViewRecord;
    readonly fileName: string;
  }) => ArtifactAssetLocation | null;
  /**
   * The artifact's canonical host-servable file when it has NO top-level
   * `storageKey` column — i.e. the capability keeps its primary deliverable
   * inside the payload (e.g. a video presentation's server-rendered mp4 under
   * `payload.renderedVideo`). The host serves these bytes on the public `/raw`
   * route and mints `fileUrl`/inline-preview from the returned content-type, so
   * a shared artifact with no top-level file can still play/download. Returning
   * null means "no host-servable primary file" and the share page falls back to
   * the poster image. Only consulted when the top-level storageKey is absent.
   */
  readonly resolvePrimaryFile?: (input: {
    readonly artifact: ArtifactViewRecord;
  }) => ArtifactAssetLocation | null;
  /** Capability-owned canonical JSON when no separately stored source exists. */
  readonly buildSourceJson?: (input: {
    readonly artifact: ArtifactViewRecord;
  }) => {
    readonly payload: Record<string, unknown>;
    readonly fileName?: string;
  } | null;
  /**
   * The payload a PUBLIC share may hand an anonymous browser so it can render
   * the artifact client-side (the same path the owner's in-app preview uses).
   * The handler owns what is safe to expose and rewrites any asset reference to
   * the caller-provided share-token URL (`assetUrl(fileName)`), so the anonymous
   * viewer can fetch sub-assets without the workspace-scoped, authenticated
   * route. Returning null means "nothing safe to client-render" and the share
   * page falls back to a file/poster. Only capabilities that render from a
   * payload implement this; the generic host never inspects payload shape.
   */
  readonly buildPublicPayload?: (input: {
    readonly artifact: ArtifactViewRecord;
    readonly assetUrl: (fileName: string) => string;
  }) => Record<string, unknown> | null;
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
  readonly ArtifactViewHandler[] | Promise<readonly ArtifactViewHandler[]>;

export const artifactSchema = z.object({
  id: z.string(),
  artifactVersionId: z.string().nullable().default(null),
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
  // True when a live (non-revoked, unexpired) public share link exists for this
  // artifact — i.e. it is published to an anonymous `/s/:token` page. Distinct
  // from `visibility`, which is workspace-scoped. Defaults false so response
  // builders that don't resolve share state stay valid.
  isPublic: z.boolean().default(false),
  createdBy: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  previewUrl: z.string().nullable(),
  capabilities: artifactCapabilitiesSchema,
});

const artifactVersionMediaAssetSchema = z
  .object({
    url: z.string().trim().min(1),
    downloadUrl: z.string().trim().min(1).optional(),
    contentType: z.string().trim().min(1),
    fileName: z.string().trim().min(1),
    byteLength: z.number().int().positive(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    fps: z.number().positive().optional(),
    hasAudio: z.boolean().optional(),
  })
  .strict();

/** Browser-safe exact-version projection. No payload source or storage keys. */
export const artifactVersionMediaProjectionSchema = z
  .object({
    artifactId: z.string().trim().min(1),
    artifactVersionId: z.string().trim().min(1),
    artifactType: artifactTypeSchema,
    title: z.string().trim().min(1),
    description: z.string().nullable(),
    durationSeconds: z.number().nonnegative().nullable(),
    media: artifactVersionMediaAssetSchema.extend({
      downloadUrl: z.string().trim().min(1),
    }),
    coverImage: artifactVersionMediaAssetSchema
      .omit({ downloadUrl: true })
      .nullable(),
  })
  .strict();

export const getArtifactVersionMediaResponseSchema = z
  .object({ media: artifactVersionMediaProjectionSchema })
  .strict();

/**
 * Bounded collection projection for artifact galleries.
 *
 * Opaque payloads, storage coordinates, error internals, and handler-resolved
 * capabilities belong to the single-artifact detail response. Keeping them out
 * of this schema makes list size independent of the generated artifact body.
 */
export const artifactSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  threadId: z.string().nullable(),
  artifactType: artifactTypeSchema,
  status: artifactStatusSchema,
  title: z.string().nullable(),
  promptExcerpt: z.string().max(300).nullable(),
  visibility: z.enum(["private", "workspace"]),
  isPublic: z.boolean(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
  hasPrimaryFile: z.boolean(),
  primaryFileUrl: z.string().nullable(),
  previewImage: z
    .object({
      url: z.string(),
      altText: z.string().nullable(),
    })
    .nullable(),
});

export const listArtifactsResponseSchema = z.object({
  items: z.array(artifactSchema),
  nextCursor: z.string().nullable().optional(),
});

export const listArtifactSummariesResponseSchema = z.object({
  items: z.array(artifactSummarySchema),
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
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;
export type GetArtifactResponse = z.infer<typeof getArtifactResponseSchema>;
export type ArtifactVersionMediaProjection = z.infer<
  typeof artifactVersionMediaProjectionSchema
>;
export type GetArtifactVersionMediaResponse = z.infer<
  typeof getArtifactVersionMediaResponseSchema
>;
export type ListArtifactsResponse = z.infer<typeof listArtifactsResponseSchema>;
export type ListArtifactSummariesResponse = z.infer<
  typeof listArtifactSummariesResponseSchema
>;
export type DeleteArtifactResponse = z.infer<
  typeof deleteArtifactResponseSchema
>;
