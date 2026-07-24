import type {
  BillingSummaryResponse,
  MeterConsumeRequest,
  MeterConsumeResponse,
  MeterIngestionRequest,
  MeterIngestionResponse,
} from "@sourceweft/contracts";

export type ContentBillingPort = {
  // Per-member: the summary/capacity reflects the acting user's own allocation.
  getSummary(teamId: string, userId: string): Promise<BillingSummaryResponse>;
  meterConsume(
    teamId: string,
    input: MeterConsumeRequest,
    actorUserId: string,
  ): Promise<MeterConsumeResponse>;
  meterIngestion(
    teamId: string,
    input: MeterIngestionRequest,
    actorUserId: string,
  ): Promise<MeterIngestionResponse>;
};
