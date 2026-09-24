import type { IngestionPageAdmissionState } from "@sourceweft/contracts/billing-runtime";
import type { ContentBillingPort } from "../content/billing-port";

export type IngestionAdmission =
  | { outcome: "admit" }
  | { outcome: "insufficient"; requested: number; available: number }
  | { outcome: "oversized"; requested: number; cycleCapacity: number };

/**
 * One sync run's view of its billing actor's ingestion pages.
 *
 * Admission is read once and consumption is tracked locally, so a run of
 * thousands of items does not take the team billing lock twice per item. The
 * local view is re-read only when it says an item would not fit, so a top-up
 * or cycle regrant mid-run is picked up before the run gives up. Settlement
 * (`meterIngestion`) stays the authority: a concurrent spender can still make
 * it reject, which callers handle exactly like `insufficient`.
 */
export class IngestionPageBudget {
  /** `undefined` = not read yet; `null` = unmetered deployment. */
  private state: IngestionPageAdmissionState | null | undefined;

  constructor(
    private readonly billing: ContentBillingPort,
    private readonly teamId: string,
    private readonly userId: string,
  ) {}

  async admit(pages: number): Promise<IngestionAdmission> {
    if (this.state === undefined) await this.refresh();
    if (this.fits(pages)) return { outcome: "admit" };
    await this.refresh();
    if (this.fits(pages)) return { outcome: "admit" };
    const state = this.state as IngestionPageAdmissionState;
    if (pages > state.cycleCapacity) {
      return {
        outcome: "oversized",
        requested: pages,
        cycleCapacity: state.cycleCapacity,
      };
    }
    return {
      outcome: "insufficient",
      requested: pages,
      available: state.available,
    };
  }

  /** Records pages settled by a successful index so the local view stays close. */
  consumed(pages: number) {
    if (this.state) {
      this.state.available = Math.max(0, this.state.available - pages);
    }
  }

  private fits(pages: number) {
    return !this.state || !this.state.enforced || pages <= this.state.available;
  }

  private async refresh() {
    const state = await this.billing.getExecutionState(
      this.teamId,
      this.userId,
    );
    this.state = state.kind === "metered" ? { ...state.ingestionPages } : null;
  }
}

/** Settlement-time rejection that a pre-work admission check can race with. */
export function isPagesLimitExceeded(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "PAGES_LIMIT_EXCEEDED"
  );
}
