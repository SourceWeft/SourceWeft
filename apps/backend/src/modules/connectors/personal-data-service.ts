/**
 * Periodic personal-data reporting pass.
 *
 * Atlassian (and any other provider whose adapter implements `personalData`)
 * requires an app that stores account identity to report the stored account
 * ids on a cycle and to act on the answer: delete the data for a `closed`
 * account, re-read or erase it for an `updated` one. This host-side pass is
 * provider-agnostic — it visits every registered adapter that declares
 * `personalData`, groups that type's stored accounts by provider account id,
 * reports the due ones in batches, and applies the provider's answer. The
 * Atlassian specifics (request shape, the reporting cycle, `/me`) live in the
 * adapter and the `@sourceweft/atlassian-client` package.
 *
 * Logs carry only the connector type, counts and an error `code` — never the
 * provider account id, email, display name, token or any provider message. The
 * pass never throws: one type's (or one batch's) failure is isolated and the
 * rest of the pass still runs. The scheduler (its own timer, like the OAuth
 * keep-alive sweep) owns the interval and raises an ops alert from the returned
 * summary's failure counts; this service does not import ops alerts.
 */
import { logger } from "../../shared/logger";
import { ConnectorError, toConnectorError } from "./errors";
import { connectorRegistry, type ConnectorRegistry } from "./registry";
import {
  deleteAccountsByProviderAccount,
  listPersonalDataAccounts,
  markPersonalDataReported,
  scrubAccountProfiles,
  updateAccountProfile,
  type PersonalDataAccountRow,
} from "./repository";
import type {
  ConnectorAdapter,
  ConnectorManifest,
  ConnectorPersonalDataAccount,
  ConnectorPersonalDataReport,
} from "@sourceweft/contracts";

/**
 * The default reporting cycle in days. Atlassian defaults to 7 and may send a
 * `Cycle-Period` header to change it, but the documented value format is not
 * confirmed, so the client always reports `cyclePeriodDays: null` (a ruling in
 * Task 1). With no per-type cycle ever supplied, this constant is always used;
 * there is deliberately no "last seen cycle" map (YAGNI) — see the task report.
 */
export const PERSONAL_DATA_DEFAULT_CYCLE_DAYS = 7;
/** Atlassian accepts at most 90 accounts per report request. */
export const PERSONAL_DATA_BATCH_SIZE = 90;
/** Active accounts tried as the report bearer before a batch is given up. */
export const PERSONAL_DATA_BEARER_ATTEMPTS = 3;

const DAY_MS = 24 * 60 * 60_000;

export type PersonalDataPassSummary = {
  /** Connector types visited (those with a `personalData` adapter). */
  types: number;
  /** Distinct provider account groups examined across all types. */
  checked: number;
  /** Account ids successfully reported and stamped. */
  reported: number;
  /** Account ids deleted because the provider reported them `closed`. */
  closed: number;
  /** Account ids acted on because the provider reported them `updated`. */
  updated: number;
  /** Rows whose stored identity was erased (updated-row failures + fail-safe). */
  scrubbed: number;
  /** Answer entries dropped by the provider or ignored as outside the batch. */
  ignored: number;
  /** Types or batches that failed with an unexpected error. */
  failed: number;
  /** Batches given up because no active account could act as the bearer. */
  skippedNoBearer: number;
};

/** Minimal shape the pass needs from the OAuth service (injected for tests). */
type PersonalDataOAuth = {
  getRuntimeToken(input: {
    teamId: string;
    workspaceId: string;
    accountId: string | null;
    connectorType: string;
  }): Promise<string>;
};

type PersonalDataRegistry = Pick<ConnectorRegistry, "getAdapter" | "listManifests">;

type PersonalData = NonNullable<ConnectorAdapter["personalData"]>;

type BatchReportOutcome =
  | { ok: true; report: ConnectorPersonalDataReport }
  | { ok: false; code: string };

function emptySummary(): PersonalDataPassSummary {
  return {
    types: 0,
    checked: 0,
    reported: 0,
    closed: 0,
    updated: 0,
    scrubbed: 0,
    ignored: 0,
    failed: 0,
    skippedNoBearer: 0,
  };
}

/**
 * Whether a report failure means "this bearer's grant no longer authorizes the
 * call" — a revoked grant (401), an unusable account (409), or an explicit
 * reauthorization code — so the next active account should be tried. Anything
 * else (a provider outage, a bad request) is not fixed by another bearer.
 */
function isBearerFallback(error: ConnectorError): boolean {
  return (
    error.statusCode === 401 ||
    error.statusCode === 409 ||
    error.code.endsWith("_REAUTH_REQUIRED")
  );
}

/** Active rows of a type, oldest `retrievedAt` first (then id), as bearers. */
function activeCandidates(
  rows: PersonalDataAccountRow[],
): PersonalDataAccountRow[] {
  return rows
    .filter((candidate) => candidate.status === "active")
    .sort((a, b) => {
      const byAge = a.retrievedAt.getTime() - b.retrievedAt.getTime();
      if (byAge !== 0) return byAge;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

export class ConnectorPersonalDataService {
  private running = false;

  constructor(
    private readonly oauth: PersonalDataOAuth,
    private readonly registry: PersonalDataRegistry = connectorRegistry,
  ) {}

  /**
   * Run one reporting pass over every registered adapter with `personalData`.
   * Returns a summary of what happened. A second call while one pass is in
   * flight returns an empty summary immediately (the scheduler's interval can
   * fire again before a slow pass finishes). Never rejects.
   */
  async runPass(input?: { now?: Date }): Promise<PersonalDataPassSummary> {
    if (this.running) {
      return emptySummary();
    }
    this.running = true;
    const summary = emptySummary();
    const now = input?.now ?? new Date();
    try {
      for (const manifest of this.registry.listManifests()) {
        let adapter: ConnectorAdapter;
        try {
          adapter = this.registry.getAdapter(manifest.type);
        } catch {
          // Switched off between listing and lookup: nothing to do.
          continue;
        }
        const personalData = adapter.personalData;
        if (!personalData) continue;
        summary.types += 1;
        try {
          await this.processType({ manifest, personalData, now, summary });
        } catch (error) {
          summary.failed += 1;
          logger.error("connector_personal_data_failed", {
            connectorType: manifest.type,
            code: toConnectorError(error).code,
          });
        }
      }
      if (summary.checked > 0) {
        logger.info("connector_personal_data_pass", summary);
      }
    } catch (error) {
      // Belt-and-braces: a failure outside per-type isolation must still not
      // reject. Record it and return the partial summary.
      logger.error("connector_personal_data_pass_failed", {
        code: toConnectorError(error).code,
      });
    } finally {
      this.running = false;
    }
    return summary;
  }

  private async processType(input: {
    manifest: ConnectorManifest;
    personalData: PersonalData;
    now: Date;
    summary: PersonalDataPassSummary;
  }): Promise<void> {
    const { manifest, personalData, now, summary } = input;
    const connectorType = manifest.type;
    const rows = await listPersonalDataAccounts({ connectorType });
    if (rows.length === 0) {
      return;
    }

    // A mutable working copy: deletions remove rows and successful reports stamp
    // `reportedAt`, so the bearer candidates and the fail-safe set below are
    // computed against the current state, not the snapshot read at the top.
    let liveRows: PersonalDataAccountRow[] = rows.map((r) => ({ ...r }));

    const cycleMs = PERSONAL_DATA_DEFAULT_CYCLE_DAYS * DAY_MS;
    const dueBefore = now.getTime() - cycleMs;

    // Group by provider account id, preserving the listing order.
    const groups = new Map<string, PersonalDataAccountRow[]>();
    for (const r of rows) {
      const group = groups.get(r.providerAccountId);
      if (group) group.push(r);
      else groups.set(r.providerAccountId, [r]);
    }
    summary.checked += groups.size;

    // Due = never reported, or last reported more than one cycle ago. The
    // account's `updatedAt` is the oldest `retrievedAt` among its rows.
    const due: ConnectorPersonalDataAccount[] = [];
    for (const [providerAccountId, groupRows] of groups) {
      const isDue = groupRows.some(
        (r) => r.reportedAt === null || r.reportedAt.getTime() < dueBefore,
      );
      if (!isDue) continue;
      const updatedAt = groupRows
        .map((r) => r.retrievedAt)
        .reduce((oldest, candidate) => (candidate < oldest ? candidate : oldest));
      due.push({ accountId: providerAccountId, updatedAt });
    }

    for (let start = 0; start < due.length; start += PERSONAL_DATA_BATCH_SIZE) {
      const batch = due.slice(start, start + PERSONAL_DATA_BATCH_SIZE);
      const batchIds = new Set(batch.map((account) => account.accountId));
      try {
        const outcome = await this.reportBatch({
          connectorType,
          personalData,
          accounts: batch,
          candidates: activeCandidates(liveRows),
        });
        if (!outcome.ok) {
          // No active account could report this batch, and the next batch of
          // the same type would only try the same failing bearers again: stop
          // the type here, counting and logging once. The fail-safe sweep after
          // the loop still runs.
          summary.skippedNoBearer += 1;
          logger.error("connector_personal_data_failed", {
            connectorType,
            code: outcome.code,
          });
          break;
        }
        const report = outcome.report;

        // A `closed` id must not be stamped reported until its deletion
        // succeeds: a stamped-but-undeleted account would look reported for a
        // whole cycle, delaying the erasure Atlassian mandates. Mark only the
        // non-closed ids now; a closed id whose delete throws stays unmarked,
        // so the next pass re-reports it, is told `closed` again, and retries.
        const closedInBatch = new Set(
          report.closed.filter((id) => batchIds.has(id)),
        );
        const reportedIds = [...batchIds].filter(
          (id) => !closedInBatch.has(id),
        );
        if (reportedIds.length > 0) {
          await markPersonalDataReported({
            connectorType,
            providerAccountIds: reportedIds,
            reportedAt: now,
          });
        }
        summary.reported += batchIds.size;
        // Reflect the stamp so the fail-safe sweep does not re-scrub a row that
        // was just reported in this pass; a closed id is left to the delete loop.
        for (const r of liveRows) {
          if (
            batchIds.has(r.providerAccountId) &&
            !closedInBatch.has(r.providerAccountId)
          ) {
            r.reportedAt = now;
          }
        }

        // Only ids actually sent in this batch are acted on; the client already
        // filters, but an id outside the batch is ignored (and counted) here too.
        for (const providerAccountId of report.closed) {
          if (!batchIds.has(providerAccountId)) {
            summary.ignored += 1;
            continue;
          }
          try {
            await deleteAccountsByProviderAccount({
              connectorType,
              providerAccountId,
            });
          } catch (error) {
            // The id was never stamped reported, so the next pass re-reports it,
            // is told `closed`, and retries. Isolate the failure and keep going
            // so the batch's other closed/updated ids are still processed.
            summary.failed += 1;
            logger.error("connector_personal_data_failed", {
              connectorType,
              code: toConnectorError(error).code,
            });
            continue;
          }
          summary.closed += 1;
          // Drop the deleted account's rows so a bearer just closed cannot be
          // reused by the next batch.
          liveRows = liveRows.filter(
            (r) => r.providerAccountId !== providerAccountId,
          );
        }
        for (const providerAccountId of report.updated) {
          if (!batchIds.has(providerAccountId)) {
            summary.ignored += 1;
            continue;
          }
          await this.refreshOrScrub({
            connectorType,
            personalData,
            rows: groups.get(providerAccountId) ?? [],
            placeholderName: manifest.displayName,
            now,
            summary,
          });
          summary.updated += 1;
        }
        summary.ignored += report.ignored;
      } catch (error) {
        // A non-bearer batch failure (a provider outage, a mark/delete error):
        // isolate it and carry on with the next batch and the fail-safe sweep.
        summary.failed += 1;
        logger.error("connector_personal_data_failed", {
          connectorType,
          code: toConnectorError(error).code,
        });
      }
    }

    // Fail-safe: a row whose personal data has not been successfully reported
    // within two cycles (reporting is failing) is scrubbed, regardless of this
    // pass's outcome. A never-reported row falls back to `retrievedAt`, which
    // equals `created_at` until a profile read stamps it. Idempotent.
    const failsafeBefore = now.getTime() - 2 * cycleMs;
    const scrubIds = liveRows
      .filter((r) => (r.reportedAt ?? r.retrievedAt).getTime() < failsafeBefore)
      .map((r) => r.id);
    if (scrubIds.length > 0) {
      summary.scrubbed += await scrubAccountProfiles({
        accountIds: scrubIds,
        placeholderName: manifest.displayName,
        at: now,
      });
    }
  }

  /**
   * Report one batch, using an active account of the type as the bearer. Any
   * token failure, or a report failure that means the bearer's grant no longer
   * authorizes the call, moves to the next active account (at most three). A
   * non-bearer report failure is thrown so the caller isolates it. Returns the
   * provider's answer, or `{ ok: false }` when no account could report it.
   */
  private async reportBatch(input: {
    connectorType: string;
    personalData: PersonalData;
    accounts: ConnectorPersonalDataAccount[];
    candidates: PersonalDataAccountRow[];
  }): Promise<BatchReportOutcome> {
    const { connectorType, personalData, accounts, candidates } = input;
    let code = "CONNECTOR_PERSONAL_DATA_NO_BEARER";
    for (const candidate of candidates.slice(0, PERSONAL_DATA_BEARER_ATTEMPTS)) {
      let accessToken: string;
      try {
        accessToken = await this.oauth.getRuntimeToken({
          teamId: candidate.teamId,
          workspaceId: candidate.workspaceId,
          accountId: candidate.id,
          connectorType,
        });
      } catch (error) {
        // Could not mint this candidate's token (revoked, unavailable, gone,
        // transient): try the next active account.
        code = toConnectorError(error).code;
        continue;
      }
      try {
        const report = await personalData.report({ accessToken, accounts });
        return { ok: true, report };
      } catch (error) {
        const connectorError = toConnectorError(error);
        if (isBearerFallback(connectorError)) {
          code = connectorError.code;
          continue;
        }
        throw error;
      }
    }
    return { ok: false, code };
  }

  /**
   * Apply an `updated` answer to one account id: for each stored row, re-read
   * the identity with that row's own token and overwrite it; if the row's token
   * can no longer read it, erase the stored email and display name instead
   * (leaving only the non-personal account id).
   */
  private async refreshOrScrub(input: {
    connectorType: string;
    personalData: PersonalData;
    rows: PersonalDataAccountRow[];
    placeholderName: string;
    now: Date;
    summary: PersonalDataPassSummary;
  }): Promise<void> {
    const { connectorType, personalData, rows, placeholderName, now, summary } =
      input;
    for (const r of rows) {
      try {
        const accessToken = await this.oauth.getRuntimeToken({
          teamId: r.teamId,
          workspaceId: r.workspaceId,
          accountId: r.id,
          connectorType,
        });
        const freshProfile = await personalData.readProfile({ accessToken });
        await updateAccountProfile({
          teamId: r.teamId,
          workspaceId: r.workspaceId,
          accountId: r.id,
          email: freshProfile.email,
          displayName: freshProfile.displayName,
          retrievedAt: now,
        });
      } catch {
        summary.scrubbed += await scrubAccountProfiles({
          accountIds: [r.id],
          placeholderName,
          at: now,
        });
      }
    }
  }
}
