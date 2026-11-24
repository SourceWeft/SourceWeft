import { z } from "zod";

export const RESEARCH_TOPIC_MAX_CHARS = 500;

export const researchStatusSchema = z.enum([
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
]);

export const researchPhaseSchema = z.enum([
  "planning",
  "searching",
  "reading",
  "reporting",
]);

export const researchErrorCodeSchema = z.enum([
  "WEB_PROVIDER_UNAVAILABLE",
  "NO_RESULTS",
  "RESEARCH_QUALITY_TOO_LOW",
  "INSUFFICIENT_CREDITS",
  "MODEL_UNAVAILABLE",
  "TIME_LIMIT",
  "ACCESS_LOST",
]);

export const researchRequestSchema = z.object({
  topic: z.string().trim().min(1).max(RESEARCH_TOPIC_MAX_CHARS),
});

export const researchProgressSchema = z.object({
  round: z.number().int().min(0),
  searches: z.number().int().min(0),
  pagesRead: z.number().int().min(0),
  modelCalls: z.number().int().min(0),
});

export const researchLedgerEntrySchema = z.object({
  id: z.string(),
  url: z.string().url(),
  title: z.string(),
  points: z.array(z.string()),
  quotes: z.array(z.string().max(400)),
});

export const researchCitationSchema = z.object({
  entryId: z.string(),
  quote: z.string(),
  status: z.literal("verified"),
});

export const researchRunSchema = z.object({
  id: z.string(),
  topic: z.string(),
  status: researchStatusSchema,
  phase: researchPhaseSchema,
  progress: researchProgressSchema,
  plan: z.array(z.string()).nullable(),
  report: z.string().nullable(),
  citations: z.array(researchCitationSchema),
  sources: z.array(
    z.object({ url: z.string(), title: z.string(), entryId: z.string() }),
  ),
  errorCode: researchErrorCodeSchema.nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

export type ResearchStatus = z.infer<typeof researchStatusSchema>;
export type ResearchPhase = z.infer<typeof researchPhaseSchema>;
export type ResearchErrorCode = z.infer<typeof researchErrorCodeSchema>;
export type ResearchRequest = z.infer<typeof researchRequestSchema>;
export type ResearchProgress = z.infer<typeof researchProgressSchema>;
export type ResearchLedgerEntry = z.infer<typeof researchLedgerEntrySchema>;
export type ResearchCitation = z.infer<typeof researchCitationSchema>;
export type ResearchRun = z.infer<typeof researchRunSchema>;
