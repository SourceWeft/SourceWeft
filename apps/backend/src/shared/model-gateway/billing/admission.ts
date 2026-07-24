import type { BillingMode } from "@sourceweft/contracts";
import type { ContentBillingPort } from "../../../modules/content/billing-port";

export type AdmissionDecision =
  | {
      readonly allowed: true;
      readonly availableCredits: number;
      readonly billingMode: BillingMode;
    }
  | {
      readonly allowed: false;
      readonly reason: "insufficient_credits";
      readonly availableCredits: number;
      readonly billingMode: BillingMode;
    };

export class BillingAdmissionError extends Error {
  readonly code = "BILLING_ADMISSION_DENIED";
  readonly statusCode = 402;

  constructor(
    readonly decision: Extract<AdmissionDecision, { allowed: false }>,
  ) {
    super(
      `Billing admission denied (${decision.reason}); available credits: ${decision.availableCredits}`,
    );
    this.name = "BillingAdmissionError";
  }
}

/**
 * Admission for a scope that spends nothing.
 *
 * Covered work is deliberately not charged, so credit balance is irrelevant to
 * whether it may run. This still reads the summary, because the scope needs the
 * team's billing mode and balance for its own bookkeeping — it just never
 * refuses. A failure to read billing state is likewise not a reason to withhold
 * work nobody is paying for.
 */
export async function admitCoveredScope(
  billing: ContentBillingPort,
  teamId: string,
  userId: string,
): Promise<AdmissionDecision> {
  try {
    const summary = await billing.getSummary(teamId, userId);
    return {
      allowed: true,
      availableCredits: summary.credits.available,
      billingMode: summary.billingMode,
    };
  } catch {
    return { allowed: true, availableCredits: 0, billingMode: "enforced" };
  }
}

/**
 * Pre-flight balance gate, evaluated once per scope rather than per model call.
 *
 * This is admission control, not accounting: it stops a team that is already
 * out of credits from starting new work, instead of discovering the shortfall
 * after the tokens have been burned. It deliberately does not reserve credits —
 * `billing_accounts.credits_reserved` stays untouched — so there is nothing to
 * leak when a worker dies mid-scope. The trade-off is a race: concurrent scopes
 * can each pass the gate and jointly overspend. That is strictly better than
 * the previous behaviour of no gate at all, and the post-hoc capacity check
 * inside meterConsume still backstops it.
 *
 * The decision is a function of the team's balance and billing mode alone. It
 * takes no feature or scope id: nothing here has ever varied by either, and
 * accepting them made every caller compute values that were then dropped.
 */
export const billingAdmission = {
  async admit({
    billing,
    teamId,
    userId,
  }: {
    billing: ContentBillingPort;
    teamId: string;
    userId: string;
  }): Promise<AdmissionDecision> {
    const summary = await billing.getSummary(teamId, userId);
    const billingMode = summary.billingMode;
    const availableCredits = summary.credits.available;

    // Only enforced mode denies. Shadow and disabled modes are observation-only
    // by definition, and auto-grant shortfalls further down the stack.
    if (billingMode === "enforced" && availableCredits <= 0) {
      return {
        allowed: false,
        reason: "insufficient_credits",
        availableCredits,
        billingMode,
      };
    }

    return { allowed: true, availableCredits, billingMode };
  },
};
