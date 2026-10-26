import { z } from "zod";
import {
  ARTIFACT_RECORD_CAPABILITIES,
  artifactRecordCapabilitySchema,
} from "./artifact-records";
import {
  artifactContentDigestSchema,
  artifactFileNameSchema,
} from "./artifact-version-files";

export const HTML_ARTIFACT_TYPE = "html";
export const HTML_ARTIFACT_RENDERER = "html-document";
export const HTML_ARTIFACT_METADATA_NAME = "sourceweft:artifact";
export const PRESENTATION_PROTOCOL = "presentation/v1";

export const presentationCapabilitySchema = z
  .object({
    protocol: z.literal(PRESENTATION_PROTOCOL),
    pages: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(128),
            title: z.string().max(300).optional(),
            thumbnail: artifactFileNameSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict()
  .superRefine(({ pages }, context) => {
    if (new Set(pages.map((page) => page.id)).size !== pages.length) {
      context.addIssue({
        code: "custom",
        path: ["pages"],
        message: "Page IDs must be unique",
      });
    }
  });

/**
 * Host capabilities a page asks for. Declaring is a request, not a grant: the
 * backend reads it from the immutable version, and `storage.shared` still
 * needs a person's approval for that exact version.
 */
export const htmlArtifactCapabilitiesSchema = z
  .array(artifactRecordCapabilitySchema)
  .max(ARTIFACT_RECORD_CAPABILITIES.length)
  .refine(
    (values) => new Set(values).size === values.length,
    "Capabilities must be unique",
  );

/** Optional metadata is a display protocol, not a generation format. */
export const htmlArtifactMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    presentation: presentationCapabilitySchema.optional(),
    capabilities: htmlArtifactCapabilitiesSchema.optional(),
  })
  .strict();

/** `storage.shared` implies `storage`; anything unparsable declares nothing. */
export function htmlArtifactRecordCapabilities(payload: unknown): {
  storage: boolean;
  shared: boolean;
} {
  const metadata =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { metadata?: unknown }).metadata
      : undefined;
  const parsed = htmlArtifactMetadataSchema.safeParse(metadata);
  const capabilities = parsed.success ? (parsed.data.capabilities ?? []) : [];
  const shared = capabilities.includes("storage.shared");
  return { storage: shared || capabilities.includes("storage"), shared };
}

export const htmlArtifactPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    fileName: artifactFileNameSchema,
    mimeType: z.literal("text/html"),
    byteLength: z.number().int().positive(),
    contentDigest: artifactContentDigestSchema,
    metadata: htmlArtifactMetadataSchema,
    validation: z
      .object({
        policyVersion: z.literal("html/1"),
        checks: z.array(
          z.enum(["utf8", "document", "resources", "metadata", "size"]),
        ),
      })
      .strict(),
  })
  .passthrough();

export type HtmlArtifactPayload = z.infer<typeof htmlArtifactPayloadSchema>;
export type PresentationCapability = z.infer<
  typeof presentationCapabilitySchema
>;

export const presentationStateSchema = z
  .object({
    slideIndex: z.number().int().nonnegative(),
    slideCount: z.number().int().min(1).max(200),
    fragmentIndex: z.number().int().min(-1).max(1000),
    overview: z.boolean(),
  })
  .strict()
  .refine(
    (state) => state.slideIndex < state.slideCount,
    "Page index is out of range",
  );

const messageBase = {
  protocol: z.literal(PRESENTATION_PROTOCOL),
  channelId: z.string().min(16).max(128),
};
export const presentationCommandSchema = z.discriminatedUnion("command", [
  z
    .object({
      ...messageBase,
      type: z.literal("command"),
      requestId: z.string().min(1).max(128),
      command: z.enum(["next", "prev"]),
    })
    .strict(),
  z
    .object({
      ...messageBase,
      type: z.literal("command"),
      requestId: z.string().min(1).max(128),
      command: z.literal("goto"),
      slideIndex: z.number().int().min(0).max(199),
    })
    .strict(),
  z
    .object({
      ...messageBase,
      type: z.literal("command"),
      requestId: z.string().min(1).max(128),
      command: z.literal("overview"),
      enabled: z.boolean(),
    })
    .strict(),
]);
export const presentationEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...messageBase,
      type: z.literal("ready"),
      state: presentationStateSchema,
    })
    .strict(),
  z
    .object({
      ...messageBase,
      type: z.literal("state"),
      state: presentationStateSchema,
    })
    .strict(),
  z
    .object({
      ...messageBase,
      type: z.literal("ack"),
      requestId: z.string().min(1).max(128),
      state: presentationStateSchema,
    })
    .strict(),
  z
    .object({
      ...messageBase,
      type: z.literal("error"),
      requestId: z.string().max(128).optional(),
      message: z.string().max(500),
    })
    .strict(),
]);
export type PresentationState = z.infer<typeof presentationStateSchema>;
