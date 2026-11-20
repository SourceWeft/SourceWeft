// Atlassian Personal Data Reporting API (OAuth 2.0 3LO flavour):
// `POST https://api.atlassian.com/app/report-accounts/`, up to 90 accounts per
// request, answered with 204 (nothing to do) or 200 `{ accounts: [{ accountId,
// status: "closed" | "updated" }] }`.
// https://developer.atlassian.com/cloud/jira/platform/user-privacy-developer-guide/
// https://developer.atlassian.com/cloud/confluence/user-privacy-developer-guide/

import { AtlassianApiError, mapApiError, unavailableError } from "./errors";
import type { AtlassianClientConfig } from "./http";

const REQUEST_TIMEOUT_MS = 30000;
const REPORT_ACCOUNTS_URL = "https://api.atlassian.com/app/report-accounts/";

/** Atlassian accepts at most 90 accounts per report request. */
export const REPORT_ACCOUNTS_MAX_BATCH = 90;

export type ReportedAccount = { accountId: string; updatedAt: Date };

export type ReportAccountsResult = {
  /** Account ids Atlassian answered "closed" for; only ids that were sent. */
  closed: string[];
  /** Account ids Atlassian answered "updated" for; only ids that were sent. */
  updated: string[];
  /** Answer entries dropped: not sent, unknown status, duplicate or malformed. */
  ignored: number;
  /** Always `null` today, see below. */
  cyclePeriodDays: number | null;
};

/**
 * The `Cycle-Period` response header.
 *
 * Both Atlassian guides only say that "the polling resources may return a
 * different cycle period (in the `Cycle-Period` header) that you must follow
 * instead" of the default 7 days. Neither the guides nor the reporting API
 * reference they link state the header's format or unit and give no example
 * value, so the format is undocumented as of 2026-11-20 and guessing it could
 * make callers report too rarely or too often. This client therefore does not
 * interpret the header: `cyclePeriodDays` is `null` for every response and
 * callers keep the documented 7 day default. Parse it here, with a test of the
 * documented format, once Atlassian specifies it.
 */
function parseCyclePeriodDays(_response: Response): number | null {
  return null;
}

function invalidRequest(config: AtlassianClientConfig, message: string): AtlassianApiError {
  return new AtlassianApiError(400, `${config.errorPrefix}_INVALID_REQUEST`, message);
}

export async function reportAccounts(
  config: AtlassianClientConfig,
  input: { accessToken: string; accounts: ReportedAccount[] },
): Promise<ReportAccountsResult> {
  const { accessToken, accounts } = input;
  if (accounts.length === 0 || accounts.length > REPORT_ACCOUNTS_MAX_BATCH) {
    throw invalidRequest(
      config,
      `Report between 1 and ${REPORT_ACCOUNTS_MAX_BATCH} accounts per request`,
    );
  }

  const fetcher = config.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(REPORT_ACCOUNTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accounts: accounts.map((account) => ({
          accountId: account.accountId,
          updatedAt: account.updatedAt.toISOString(),
        })),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw unavailableError(config.errorPrefix);
  }
  if (!response.ok) {
    throw mapApiError(response, config.errorPrefix);
  }

  const cyclePeriodDays = parseCyclePeriodDays(response);
  if (response.status === 204) {
    return { closed: [], updated: [], ignored: 0, cyclePeriodDays };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A 2xx whose body cannot be parsed is an outage, not valid data.
    throw unavailableError(config.errorPrefix);
  }
  const answers =
    typeof body === "object" && body !== null ? (body as { accounts?: unknown }).accounts : undefined;
  if (!Array.isArray(answers)) {
    throw unavailableError(config.errorPrefix);
  }

  const sent = new Set(accounts.map((account) => account.accountId));
  const seen = new Set<string>();
  const closed: string[] = [];
  const updated: string[] = [];
  let ignored = 0;
  for (const answer of answers as unknown[]) {
    if (typeof answer !== "object" || answer === null) {
      ignored += 1;
      continue;
    }
    const { accountId, status } = answer as { accountId?: unknown; status?: unknown };
    if (
      typeof accountId !== "string" ||
      !sent.has(accountId) ||
      seen.has(accountId) ||
      (status !== "closed" && status !== "updated")
    ) {
      ignored += 1;
      continue;
    }
    seen.add(accountId);
    (status === "closed" ? closed : updated).push(accountId);
  }
  return { closed, updated, ignored, cyclePeriodDays };
}
