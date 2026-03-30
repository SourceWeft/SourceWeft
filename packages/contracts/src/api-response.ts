import { z } from "zod";

export const apiErrorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
