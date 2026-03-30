import { z } from "zod";

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const createJobRequestSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const createJobResponseSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: jobStatusSchema,
});

export const jobDetailsResponseSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: jobStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const jobEventSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  type: z.enum(["created", "status_changed", "cancel_requested", "log"]),
  message: z.string(),
  createdAt: z.string(),
});

export const jobEventsResponseSchema = z.object({
  items: z.array(jobEventSchema),
});

export const cancelJobResponseSchema = z.object({
  id: z.string(),
  implemented: z.literal(false),
  message: z.string(),
});

export type JobStatus = z.infer<typeof jobStatusSchema>;
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;
export type CreateJobResponse = z.infer<typeof createJobResponseSchema>;
export type JobDetailsResponse = z.infer<typeof jobDetailsResponseSchema>;
export type JobEvent = z.infer<typeof jobEventSchema>;
export type JobEventsResponse = z.infer<typeof jobEventsResponseSchema>;
export type CancelJobResponse = z.infer<typeof cancelJobResponseSchema>;
