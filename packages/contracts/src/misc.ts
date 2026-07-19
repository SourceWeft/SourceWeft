import { z } from "zod";
import { billingSummaryResponseSchema } from "./billing";
import { retrievalCitationSchema } from "./sources";

export const citationDetailResponseSchema = z.object({
  citation: retrievalCitationSchema,
});

export const billingDashboardResponseSchema = z.object({
  summary: billingSummaryResponseSchema,
});

export type CitationDetailResponse = z.infer<
  typeof citationDetailResponseSchema
>;
