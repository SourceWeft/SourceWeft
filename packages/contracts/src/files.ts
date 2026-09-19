import { z } from "zod";

export const fileBackendSchema = z.enum(["cloud_vfs", "local_fs"]);
export const fileOriginSchema = z.enum([
  "user_provided",
  "agent_created",
  "external",
  "unknown",
]);
export const fileRevisionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const fileRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !/[\\\x00-\x1f\x7f]/.test(path) &&
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "A relative file path beneath the authorized root is required",
  );

export const fileLocatorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("lines"),
      start: z.number().int().positive(),
      end: z.number().int().positive(),
    })
    .refine((value) => value.end >= value.start),
  z.object({ kind: z.literal("page"), page: z.number().int().positive() }),
  z.object({ kind: z.literal("slide"), slide: z.number().int().positive() }),
  z.object({
    kind: z.literal("paragraph"),
    index: z.number().int().nonnegative(),
    heading: z.string().optional(),
  }),
  z.object({
    kind: z.literal("cells"),
    sheet: z.string().min(1).max(256),
    range: z.string().min(1).max(64),
  }),
  z.object({ kind: z.literal("image") }),
]);

export const fileCapabilitiesSchema = z.object({
  readText: z.boolean(),
  readDocument: z.boolean(),
  viewImage: z.boolean(),
  searchText: z.boolean(),
  write: z.boolean(),
});

/** Identity and capabilities are returned by the host, never supplied as authorization. */
export const fileRefSchema = z.object({
  scopeKind: z.literal("files"),
  backendKind: fileBackendSchema,
  fileId: z.string().min(1),
  relativePath: fileRelativePathSchema,
  name: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  revision: fileRevisionSchema,
  origin: fileOriginSchema,
  capabilities: fileCapabilitiesSchema,
});

export const fileSearchCoverageSchema = z
  .object({
    status: z.enum(["complete", "partial"]),
    visited: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    truncated: z.boolean(),
    continuation: z.string().nullable(),
  })
  .refine(
    (value) =>
      value.status !== "complete" ||
      (value.skipped === 0 &&
        value.failed === 0 &&
        !value.truncated &&
        value.continuation === null),
    "Complete coverage cannot omit files or remaining results",
  );

export type FileRef = z.infer<typeof fileRefSchema>;
export type FileLocator = z.infer<typeof fileLocatorSchema>;
export type FileCapabilities = z.infer<typeof fileCapabilitiesSchema>;
export type FileSearchCoverage = z.infer<typeof fileSearchCoverageSchema>;

export const fileReferenceSchema = z.object({
  presentation: z.enum(["text", "visual"]),
  workspaceId: z.string().min(1),
  threadId: z.string().min(1),
  file: fileRefSchema,
  locator: fileLocatorSchema,
});
export type FileReference = z.infer<typeof fileReferenceSchema>;
