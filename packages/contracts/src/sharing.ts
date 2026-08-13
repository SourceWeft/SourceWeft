import { z } from "zod";
import { artifactTypeSchema } from "./artifacts";

/**
 * External sharing contracts.
 *
 * A share is a link-based, anonymous-viewable publication of a resource,
 * orthogonal to internal workspace visibility. v1 covers artifacts; the
 * `targetType` leaves room for threads later.
 */

export const shareTargetTypeSchema = z.enum(["artifact", "thread"]);
/** Anonymous link viewers are read-only; widen only when editing shares ship. */
export const shareAccessLevelSchema = z.enum(["viewer"]);

/** The owner-facing view of a share (what the creator manages). */
export const shareLinkSchema = z.object({
  token: z.string(),
  url: z.string(),
  targetType: shareTargetTypeSchema,
  targetId: z.string(),
  isPublic: z.boolean(),
  noindex: z.boolean(),
  accessLevel: shareAccessLevelSchema,
  viewCount: z.number().int().nonnegative(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

export const createArtifactShareRequestSchema = z.object({
  /** Opt out of search indexing for a sensitive one-off. Defaults to indexed. */
  noindex: z.boolean().optional(),
  /** ISO timestamp; null/omitted = never expires. */
  expiresAt: z.string().nullable().optional(),
});

export const updateArtifactShareRequestSchema = z.object({
  noindex: z.boolean().optional(),
  expiresAt: z.string().nullable().optional(),
});

export const shareResponseSchema = z.object({
  share: shareLinkSchema,
});

/** Current share for a resource, or null when it is not shared. */
export const getShareResponseSchema = z.object({
  share: shareLinkSchema.nullable(),
});

/**
 * The public projection a viewer of `/s/:token` receives. Deliberately narrow:
 * only what is needed to render the artifact read-only, plus card metadata for
 * social unfurls. No workspace, thread, source, or creator-identity leakage.
 *
 * The internal `payloadJson` is intentionally absent: it embeds workspace-
 * scoped URLs, job ids, source JSON, and storage keys that must never reach an
 * anonymous token holder. The page renders solely from `fileUrl` (the
 * sandboxed artifact bytes) and the metadata below. Extend this only with
 * fields the public renderer genuinely consumes, after sanitizing them.
 */
export const publicSharedArtifactSchema = z.object({
  token: z.string(),
  artifactType: artifactTypeSchema,
  title: z.string().nullable(),
  /** Signed, time-limited URL to the artifact's primary bytes (or null). */
  fileUrl: z.string().nullable(),
  /**
   * Whether `fileUrl` renders inside the share page's sandboxed iframe (images,
   * text, PDF, JSON, media). False for office docs (e.g. `.pptx`) and other
   * binaries, which a browser downloads rather than displays — the page falls
   * back to `previewImageUrl` for those instead of showing a blank frame.
   */
  inlinePreviewable: z.boolean(),
  /** Signed URL to a preview image (social card + non-embeddable fallback). */
  previewImageUrl: z.string().nullable(),
  /**
   * A capability-sanitized project payload for shares that client-render in the
   * viewer's browser (e.g. a video presentation), with every asset URL rewritten
   * to the share-token asset route. Null when the artifact has no
   * client-renderable payload (the page then uses `fileUrl`/`previewImageUrl`).
   * Only a capability's `buildPublicPayload` writes this: internal fields
   * (source material, storage keys, workspace URLs) are stripped or rewritten
   * before it crosses the public boundary.
   */
  payload: z.record(z.string(), z.unknown()).nullable(),
  /**
   * A short, content-derived summary for SEO/social descriptions, or null. Kept
   * to non-sensitive, already-shown text (the preview image's alt caption) —
   * never `promptText` or any internal payload. The renderer falls back to a
   * title + type sentence when this is null.
   */
  description: z.string().nullable(),
  viewCount: z.number().int().nonnegative(),
  noindex: z.boolean(),
  createdAt: z.string(),
});

export const publicSharedArtifactResponseSchema = z.object({
  artifact: publicSharedArtifactSchema,
});

export type ShareTargetType = z.infer<typeof shareTargetTypeSchema>;
export type ShareAccessLevel = z.infer<typeof shareAccessLevelSchema>;
export type ShareLink = z.infer<typeof shareLinkSchema>;
export type CreateArtifactShareRequest = z.infer<
  typeof createArtifactShareRequestSchema
>;
export type UpdateArtifactShareRequest = z.infer<
  typeof updateArtifactShareRequestSchema
>;
export type ShareResponse = z.infer<typeof shareResponseSchema>;
export type GetShareResponse = z.infer<typeof getShareResponseSchema>;
export type PublicSharedArtifact = z.infer<typeof publicSharedArtifactSchema>;
export type PublicSharedArtifactResponse = z.infer<
  typeof publicSharedArtifactResponseSchema
>;
