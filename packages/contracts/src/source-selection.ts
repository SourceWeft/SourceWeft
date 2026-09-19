import { z } from "zod";

export const sourceSelectionIdsSchema = z
  .array(z.string().trim().min(1))
  .max(100)
  .transform((ids) => [...new Set(ids)]);

export const threadSourceSelectionSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    selectedSourceIds: sourceSelectionIdsSchema,
  })
  .strict();

export const updateThreadSourceSelectionRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    selectedSourceIds: sourceSelectionIdsSchema,
  })
  .strict();

export type ThreadSourceSelection = z.infer<typeof threadSourceSelectionSchema>;
export type UpdateThreadSourceSelectionRequest = z.infer<
  typeof updateThreadSourceSelectionRequestSchema
>;
export type ThreadSourceSelectionResponse = {
  selection: ThreadSourceSelection;
};
