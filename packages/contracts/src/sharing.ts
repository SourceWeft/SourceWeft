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
export const shareAccessLevelSchema = z.enum(["viewer", "editor"]);

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
 */
export const publicSharedArtifactSchema = z.object({
  token: z.string(),
  artifactType: artifactTypeSchema,
  title: z.string().nullable(),
  /** Signed, time-limited URL to the artifact's primary bytes (or null). */
  fileUrl: z.string().nullable(),
  /** Signed URL to a preview image for the social card (or null). */
  previewImageUrl: z.string().nullable(),
  payloadJson: z.record(z.string(), z.unknown()),
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
