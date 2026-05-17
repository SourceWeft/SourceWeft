import type {
  BillingSubscriptionResponse,
  BillingOrderResponse,
  BillingLedgerResponse,
  BillingSummaryResponse,
  BillingUsageResponse,
  CancelTeamSubscriptionResponse,
  CreateTeamBillingPortalResponse,
  CreatePricingCheckoutRequest,
  CreatePricingCheckoutResponse,
  CreateTeamSubscriptionCheckoutRequest,
  CreateTeamSubscriptionCheckoutResponse,
  CreateTopupCheckoutRequest,
  CreateTopupCheckoutResponse,
  PreviewTeamSubscriptionSeatsResponse,
  UpdateTeamSubscriptionSeatsRequest,
  UpdateTeamSubscriptionSeatsResponse,
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

  getLedger(
    teamId: string,
    input?: { cursor?: string; limit?: number; activity?: boolean },
  ) {
    const params = new URLSearchParams();
    if (input?.limit) {
      params.set("limit", String(input.limit));
    }
    if (input?.cursor) {
      params.set("cursor", input.cursor);
    }
    if (input?.activity) {
      params.set("activity", "true");
    }
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.http.get<BillingLedgerResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/ledger${query}`,
    );
  }

  getActivity(teamId: string, input?: { cursor?: string; limit?: number }) {
    const params = new URLSearchParams();
    if (input?.limit) {
      params.set("limit", String(input.limit));
    }
    if (input?.cursor) {
      params.set("cursor", input.cursor);
    }
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.http.get<BillingLedgerResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/activity${query}`,
    );
  }

  updateSpendLimits(teamId: string, input: UpdateSpendLimitsRequest) {
    return this.http.post<UpdateSpendLimitsResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/spend-limits`,
      input,
    );
  }

  createPricingCheckout(input: CreatePricingCheckoutRequest) {
    return this.http.post<CreatePricingCheckoutResponse>(
      "/v1/billing/pricing/checkout",
      input,
    );
  }

  getOrder(orderId: string) {
    return this.http.get<BillingOrderResponse>(
      `/v1/billing/orders/${encodeURIComponent(orderId)}`,
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

  updateSubscriptionSeats(
    teamId: string,
    input: UpdateTeamSubscriptionSeatsRequest,
  ) {
    return this.http.post<UpdateTeamSubscriptionSeatsResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/subscription/seats`,
      input,
    );
  }

  previewSubscriptionSeats(
    teamId: string,
    input: UpdateTeamSubscriptionSeatsRequest,
  ) {
    return this.http.post<PreviewTeamSubscriptionSeatsResponse>(
      `/v1/teams/${encodeTeamId(teamId)}/billing/subscription/seats/preview`,
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

}
