import { connectorPersonalDataService } from "../../modules/connectors";
import { opsAlertService } from "../../modules/ops";
import { logger } from "../../shared/logger";
import { safeErrorMessage } from "../../shared/safe-error-text";

/** How often the provider personal data pass runs; see `runPass`. */
export const PERSONAL_DATA_PASS_INTERVAL_MS = 6 * 60 * 60_000;

// Not one of tick()'s jobs, for the same reason as the OAuth keep-alive sweep:
// a pass over many accounts against a slow provider can legitimately run far
// longer than tick's STUCK_TICK_MS budget, so scheduler/main.ts starts this on
// its own timer. The in-flight guard stands in for that timer's own overlap
// protection (the service also refuses a concurrent pass of its own).
let personalDataPassInFlight = false;

/**
 * Report and reconcile provider personal data for connected accounts. Returns
 * immediately, without calling `runPass`, while a previous pass in this process
 * is still running. Never rejects: a failed pass is logged and the guard is
 * still released, so the next interval tries again.
 *
 * The service raises no alerts itself. When accounts failed or could not be
 * processed for lack of a bearer, one alert carries the counts only, never
 * account ids, emails, names or provider messages.
 */
export async function runConnectorPersonalDataPass(
  now: Date = new Date(),
): Promise<void> {
  if (personalDataPassInFlight) {
    return;
  }
  personalDataPassInFlight = true;
  try {
    const summary = await connectorPersonalDataService.runPass({ now });
    if (summary.failed + summary.skippedNoBearer > 0) {
      try {
        await opsAlertService.trigger({
          alertKey: "scheduler:connector-personal-data:failure",
          level: "error",
          source: "scheduler",
          title: "Connector personal data pass incomplete",
          message: `${summary.failed} failed, ${summary.skippedNoBearer} skipped for lack of a bearer`,
          metadata: {
            failed: summary.failed,
            skippedNoBearer: summary.skippedNoBearer,
          },
        });
      } catch (alertError) {
        logger.error("Failed to emit connector personal data alert", {
          message: safeErrorMessage(alertError),
        });
      }
    }
  } catch (error) {
    logger.error("Failed to run connector personal data pass", {
      message: safeErrorMessage(error),
    });
  } finally {
    personalDataPassInFlight = false;
  }
}
