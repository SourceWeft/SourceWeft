import type {
  BillingSubscriptionResponse,
  BillingLedgerResponse,
  BillingSummaryResponse,
  BillingUsageResponse,
  CancelTeamSubscriptionResponse,
  CreateTeamBillingPortalResponse,
  CreateTeamSubscriptionCheckoutRequest,
  CreateTeamSubscriptionCheckoutResponse,
  CreateTopupCheckoutRequest,
  CreateTopupCheckoutResponse,
  MeterConsumeRequest,
  MeterConsumeResponse,
  MeterIngestionRequest,
  MeterIngestionResponse,
  UpdateSpendLimitsRequest,
  UpdateSpendLimitsResponse,
} from "@sourceweft/contracts";
import { HttpClient } from "./http-client";

function encodeTeamId(teamId: string) {
  return encodeURIComponent(teamId);
}

export class BillingClient {
  constructor(private readonly http: HttpClient) {}

  getSummary(teamId: string) {
    return this.http.get<BillingSummaryResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/summary`,
    );
  }

  getUsage(teamId: string) {
    return this.http.get<BillingUsageResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/usage`,
    );
  }

  getLedger(teamId: string) {
    return this.http.get<BillingLedgerResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/ledger`,
    );
  }

  updateSpendLimits(teamId: string, input: UpdateSpendLimitsRequest) {
    return this.http.post<UpdateSpendLimitsResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/spend-limits`,
      input,
    );
  }

  createTopupCheckout(teamId: string, input: CreateTopupCheckoutRequest) {
    return this.http.post<CreateTopupCheckoutResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/topups/checkout`,
      input,
    );
  }

  getSubscription(teamId: string) {
    return this.http.get<BillingSubscriptionResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/subscription`,
    );
  }

  createSubscriptionCheckout(
    teamId: string,
    input: CreateTeamSubscriptionCheckoutRequest,
  ) {
    return this.http.post<CreateTeamSubscriptionCheckoutResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/subscription/checkout`,
      input,
    );
  }

  createBillingPortal(teamId: string) {
    return this.http.post<CreateTeamBillingPortalResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/subscription/portal`,
      {},
    );
  }

  cancelSubscription(teamId: string) {
    return this.http.post<CancelTeamSubscriptionResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/subscription/cancel`,
      {},
    );
  }

  meterConsume(teamId: string, input: MeterConsumeRequest) {
    return this.http.post<MeterConsumeResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/meter/consume`,
      input,
    );
  }

  meterIngestion(teamId: string, input: MeterIngestionRequest) {
    return this.http.post<MeterIngestionResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/meter/ingestion`,
      input,
    );
  }
}
