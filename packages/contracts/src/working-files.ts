import { z } from "zod";

export const workingFilePurposeSchema = z.enum([
  "scratch",
  "draft",
  "note",
  "output_candidate",
]);

export const workingFileSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  workspaceId: z.string(),
  threadId: z.string(),
  path: z.string(),
  contentText: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  purpose: workingFilePurposeSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listWorkingFilesResponseSchema = z.object({
  items: z.array(workingFileSchema.omit({ contentText: true })),
});

export const getWorkingFileResponseSchema = z.object({
  file: workingFileSchema,
});

export const putWorkingFileRequestSchema = z
  .object({
    contentText: z.string().max(256 * 1024),
    mimeType: z.string().trim().min(1).max(128).optional(),
    purpose: workingFilePurposeSchema.nullable().optional(),
  })
  .strict();

export const putWorkingFileResponseSchema = z.object({
  file: workingFileSchema,
});

export const deleteWorkingFileResponseSchema = z.object({
  deleted: z.literal(true),
  path: z.string(),
});

export type WorkingFilePurpose = z.infer<typeof workingFilePurposeSchema>;
export type WorkingFile = z.infer<typeof workingFileSchema>;
export type ListWorkingFilesResponse = z.infer<
  typeof listWorkingFilesResponseSchema
>;
export type GetWorkingFileResponse = z.infer<
  typeof getWorkingFileResponseSchema
>;
export type PutWorkingFileRequest = z.infer<typeof putWorkingFileRequestSchema>;
export type PutWorkingFileResponse = z.infer<
  typeof putWorkingFileResponseSchema
>;
export type DeleteWorkingFileResponse = z.infer<
  typeof deleteWorkingFileResponseSchema
>;
