import { beforeEach, expect, it, vi } from "vitest";
import { ConnectorError } from "./errors";
import type { PersonalDataAccountRow } from "./repository";
import type {
  ConnectorPersonalDataReport,
  ConnectorAccountProfile,
} from "@sourceweft/contracts";

// The service touches the repository, the logger, the registry and the OAuth
// service. The repository and logger are module imports, so they are mocked;
// the registry and the OAuth service are injected through the constructor, so
// they are passed as fakes (as `oauth-refresh-lock.test.ts` injects a fake
// registry into `ConnectorOAuthService`).
const mocks = vi.hoisted(() => ({
  listPersonalDataAccounts: vi.fn(),
  markPersonalDataReported: vi.fn(),
  deleteAccountsByProviderAccount: vi.fn(),
  updateAccountProfile: vi.fn(),
  scrubAccountProfiles: vi.fn(),
  getAdapter: vi.fn(),
  listManifests: vi.fn(),
  getRuntimeToken: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: mocks.error, debug: vi.fn() },
}));
vi.mock("./repository", () => ({
  listPersonalDataAccounts: mocks.listPersonalDataAccounts,
  markPersonalDataReported: mocks.markPersonalDataReported,
  deleteAccountsByProviderAccount: mocks.deleteAccountsByProviderAccount,
  updateAccountProfile: mocks.updateAccountProfile,
  scrubAccountProfiles: mocks.scrubAccountProfiles,
}));

import { ConnectorPersonalDataService } from "./personal-data-service";

type Row = PersonalDataAccountRow;

const NOW = new Date("2026-11-20T00:00:00.000Z");
const DAY = 24 * 60 * 60_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const EMPTY = {
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

const emptyReport = (): ConnectorPersonalDataReport => ({
  closed: [],
  updated: [],
  ignored: 0,
  cyclePeriodDays: null,
});

const profile = (
  overrides: Partial<ConnectorAccountProfile> = {},
): ConnectorAccountProfile => ({
  providerAccountId: "atl-x",
  email: "fresh@example.com",
  displayName: "Fresh Name",
  ...overrides,
});

function row(
  overrides: Partial<Row> & Pick<Row, "id" | "providerAccountId">,
): Row {
  return {
    id: overrides.id,
    teamId: overrides.teamId ?? "team-1",
    workspaceId: overrides.workspaceId ?? "ws-1",
    connectorType: overrides.connectorType ?? "jira",
    status: overrides.status ?? "active",
    providerAccountId: overrides.providerAccountId,
    retrievedAt: overrides.retrievedAt ?? daysAgo(1),
    reportedAt: overrides.reportedAt ?? null,
  };
}

const registry = {
  getAdapter: mocks.getAdapter,
  listManifests: mocks.listManifests,
};
const oauth = { getRuntimeToken: mocks.getRuntimeToken };

let service: ConnectorPersonalDataService;

/** Register one connector type whose adapter implements `personalData`. */
function wireType(
  type: string,
  displayName: string,
  personalData: unknown,
  rows: Row[],
) {
  mocks.listManifests.mockReturnValue([{ type, displayName }] as never);
  mocks.getAdapter.mockReturnValue({ personalData } as never);
  mocks.listPersonalDataAccounts.mockResolvedValue(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRuntimeToken.mockImplementation(
    async ({ accountId }: { accountId: string }) => `bearer-${accountId}`,
  );
  mocks.markPersonalDataReported.mockResolvedValue(0);
  mocks.deleteAccountsByProviderAccount.mockResolvedValue({
    accountsDeleted: 1,
    connectorsDeleted: 0,
  });
  mocks.updateAccountProfile.mockResolvedValue(undefined);
  mocks.scrubAccountProfiles.mockImplementation(
    async ({ accountIds }: { accountIds: string[] }) => accountIds.length,
  );
  mocks.listPersonalDataAccounts.mockResolvedValue([]);
  mocks.listManifests.mockReturnValue([]);
  service = new ConnectorPersonalDataService(oauth as never, registry as never);
});

// (a) one report entry per (type, account id) with the oldest retrievedAt; two
// types are reported separately, each with its own bearer.
it("reports one entry per (type, account id) with the oldest retrievedAt, each type with its own bearer", async () => {
  const jiraRows: Row[] = [
    row({ id: "j-a-old", providerAccountId: "atl-a", retrievedAt: daysAgo(10) }),
    row({
      id: "j-a-new",
      providerAccountId: "atl-a",
      retrievedAt: daysAgo(3),
      workspaceId: "ws-2",
    }),
    row({ id: "j-b", providerAccountId: "atl-b", retrievedAt: daysAgo(5) }),
  ];
  const confRows: Row[] = [
    row({
      id: "c-1",
      providerAccountId: "atl-c",
      connectorType: "confluence",
      retrievedAt: daysAgo(4),
    }),
  ];
  const jiraReport = vi.fn().mockResolvedValue(emptyReport());
  const confReport = vi.fn().mockResolvedValue(emptyReport());
  mocks.listManifests.mockReturnValue([
    { type: "jira", displayName: "Jira" },
    { type: "confluence", displayName: "Confluence" },
  ] as never);
  mocks.getAdapter.mockImplementation((type: string) =>
    (type === "jira"
      ? { personalData: { report: jiraReport, readProfile: vi.fn() } }
      : { personalData: { report: confReport, readProfile: vi.fn() } }) as never,
  );
  mocks.listPersonalDataAccounts.mockImplementation(
    async ({ connectorType }: { connectorType: string }) =>
      connectorType === "jira" ? jiraRows : confRows,
  );

  const summary = await service.runPass({ now: NOW });

  // One entry per account id, with the oldest retrievedAt of that id's rows.
  expect(jiraReport).toHaveBeenCalledTimes(1);
  expect(jiraReport).toHaveBeenCalledWith({
    accessToken: "bearer-j-a-old", // oldest active row is the bearer
    accounts: [
      { accountId: "atl-a", updatedAt: daysAgo(10) },
      { accountId: "atl-b", updatedAt: daysAgo(5) },
    ],
  });
  // The second type is reported separately with its own bearer.
  expect(confReport).toHaveBeenCalledWith({
    accessToken: "bearer-c-1",
    accounts: [{ accountId: "atl-c", updatedAt: daysAgo(4) }],
  });
  expect(mocks.markPersonalDataReported).toHaveBeenCalledWith({
    connectorType: "jira",
    providerAccountIds: ["atl-a", "atl-b"],
    reportedAt: NOW,
  });
  expect(mocks.markPersonalDataReported).toHaveBeenCalledWith({
    connectorType: "confluence",
    providerAccountIds: ["atl-c"],
    reportedAt: NOW,
  });
  expect(summary).toEqual({
    ...EMPTY,
    types: 2,
    checked: 3,
    reported: 3,
  });
});

// (b) due accounts are batched at 90.
it("splits due accounts into batches of 90", async () => {
  const rows: Row[] = [];
  for (let i = 0; i < 91; i++) {
    rows.push(
      row({
        id: `r-${String(i).padStart(3, "0")}`,
        providerAccountId: `atl-${String(i).padStart(3, "0")}`,
        retrievedAt: new Date(NOW.getTime() - (100 - i) * DAY),
      }),
    );
  }
  const report = vi.fn().mockResolvedValue(emptyReport());
  wireType("jira", "Jira", { report, readProfile: vi.fn() }, rows);

  const summary = await service.runPass({ now: NOW });

  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.calls[0]?.[0].accounts).toHaveLength(90);
  expect(report.mock.calls[1]?.[0].accounts).toHaveLength(1);
  expect(mocks.markPersonalDataReported).toHaveBeenCalledTimes(2);
  expect(summary).toMatchObject({ checked: 91, reported: 91 });
});

// (c) groups reported within the cycle are skipped.
it("skips groups reported within the cycle", async () => {
  const rows: Row[] = [
    row({ id: "r-due", providerAccountId: "atl-due", reportedAt: daysAgo(8) }),
    row({
      id: "r-fresh",
      providerAccountId: "atl-fresh",
      reportedAt: daysAgo(2),
    }),
  ];
  const report = vi.fn().mockResolvedValue(emptyReport());
  wireType("jira", "Jira", { report, readProfile: vi.fn() }, rows);

  const summary = await service.runPass({ now: NOW });

  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0]?.[0].accounts).toEqual([
    { accountId: "atl-due", updatedAt: expect.any(Date) },
  ]);
  expect(mocks.markPersonalDataReported).toHaveBeenCalledWith({
    connectorType: "jira",
    providerAccountIds: ["atl-due"],
    reportedAt: NOW,
  });
  expect(summary).toMatchObject({ checked: 2, reported: 1 });
});

// (d) a token failure or a 401 falls through to the next active bearer.
it("falls through to the next active bearer on a token failure or a 401", async () => {
  const rows: Row[] = [
    row({ id: "r-1", providerAccountId: "atl-1", retrievedAt: daysAgo(3) }),
    row({ id: "r-2", providerAccountId: "atl-2", retrievedAt: daysAgo(2) }),
    row({ id: "r-3", providerAccountId: "atl-3", retrievedAt: daysAgo(1) }),
  ];
  const report = vi
    .fn()
    .mockRejectedValueOnce(
      new ConnectorError(401, "ATLASSIAN_UNAUTHORIZED", "revoked"),
    )
    .mockResolvedValueOnce(emptyReport());
  mocks.getRuntimeToken.mockImplementation(
    async ({ accountId }: { accountId: string }) => {
      if (accountId === "r-1") {
        throw new ConnectorError(
          409,
          "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE",
          "x",
        );
      }
      return `bearer-${accountId}`;
    },
  );
  wireType("jira", "Jira", { report, readProfile: vi.fn() }, rows);

  const summary = await service.runPass({ now: NOW });

  // r-1 token failed → skipped; r-2 reported 401 → skipped; r-3 succeeded.
  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.calls[0]?.[0].accessToken).toBe("bearer-r-2");
  expect(report.mock.calls[1]?.[0].accessToken).toBe("bearer-r-3");
  expect(mocks.getRuntimeToken).toHaveBeenCalledTimes(3);
  expect(mocks.markPersonalDataReported).toHaveBeenCalledTimes(1);
  expect(summary).toMatchObject({ reported: 3, skippedNoBearer: 0, failed: 0 });
});

// (d) three bearer failures stop the type with no mark and no delete.
it("stops the type after three bearer failures, marking and deleting nothing", async () => {
  const rows: Row[] = [
    row({ id: "r-1", providerAccountId: "atl-1", retrievedAt: daysAgo(3) }),
    row({ id: "r-2", providerAccountId: "atl-2", retrievedAt: daysAgo(2) }),
    row({ id: "r-3", providerAccountId: "atl-3", retrievedAt: daysAgo(1) }),
  ];
  const report = vi
    .fn()
    .mockRejectedValue(
      new ConnectorError(401, "ATLASSIAN_UNAUTHORIZED", "revoked"),
    );
  wireType("jira", "Jira", { report, readProfile: vi.fn() }, rows);

  const summary = await service.runPass({ now: NOW });

  expect(report).toHaveBeenCalledTimes(3); // at most 3 bearers
  expect(mocks.markPersonalDataReported).not.toHaveBeenCalled();
  expect(mocks.deleteAccountsByProviderAccount).not.toHaveBeenCalled();
  expect(summary).toMatchObject({
    skippedNoBearer: 1,
    reported: 0,
    failed: 0,
  });
  expect(mocks.error).toHaveBeenCalledWith("connector_personal_data_failed", {
    connectorType: "jira",
    code: "ATLASSIAN_UNAUTHORIZED",
  });
});

// (e) closed ids are deleted through the repository for that type only.
it("deletes closed accounts for that connector type only", async () => {
  const rows: Row[] = [
    row({ id: "r-1", providerAccountId: "atl-1", retrievedAt: daysAgo(2) }),
  ];
  const report = vi.fn().mockResolvedValue({
    closed: ["atl-1"],
    updated: [],
    ignored: 0,
    cyclePeriodDays: null,
  });
  wireType("jira", "Jira", { report, readProfile: vi.fn() }, rows);

  const summary = await service.runPass({ now: NOW });

  expect(mocks.deleteAccountsByProviderAccount).toHaveBeenCalledTimes(1);
  expect(mocks.deleteAccountsByProviderAccount).toHaveBeenCalledWith({
    connectorType: "jira",
    providerAccountId: "atl-1",
  });
  expect(summary).toMatchObject({ closed: 1, reported: 1 });
});

// (f) updated ids refresh the profile; a row whose token fails is scrubbed.
it("refreshes updated accounts and scrubs a row whose profile cannot be read", async () => {
  const rows: Row[] = [
    row({ id: "r-ok", providerAccountId: "atl-u", retrievedAt: daysAgo(3) }),
    row({
      id: "r-bad",
      providerAccountId: "atl-u",
      retrievedAt: daysAgo(2),
      workspaceId: "ws-2",
    }),
  ];
  const readProfile = vi
    .fn()
    .mockResolvedValue(profile({ providerAccountId: "atl-u" }));
  mocks.getRuntimeToken.mockImplementation(
    async ({ accountId }: { accountId: string }) => {
      if (accountId === "r-bad") {
        throw new ConnectorError(
          409,
          "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE",
          "x",
        );
      }
      return `bearer-${accountId}`;
    },
  );
  const report = vi.fn().mockResolvedValue({
    closed: [],
    updated: ["atl-u"],
    ignored: 0,
    cyclePeriodDays: null,
  });
  wireType("jira", "Jira", { report, readProfile }, rows);

  const summary = await service.runPass({ now: NOW });

  expect(mocks.updateAccountProfile).toHaveBeenCalledTimes(1);
  expect(mocks.updateAccountProfile).toHaveBeenCalledWith({
    teamId: "team-1",
    workspaceId: "ws-1",
    accountId: "r-ok",
    email: "fresh@example.com",
    displayName: "Fresh Name",
    retrievedAt: NOW,
  });
  expect(mocks.scrubAccountProfiles).toHaveBeenCalledWith({
    accountIds: ["r-bad"],
    placeholderName: "Jira",
    at: NOW,
  });
  expect(summary).toMatchObject({ updated: 1, scrubbed: 1, reported: 1 });
});

// (g) an answered id that was not sent in the batch is ignored.
it("ignores an answered id that was not in the batch", async () => {
  const rows: Row[] = [
    row({ id: "r-1", providerAccountId: "atl-in", retrievedAt: daysAgo(2) }),
  ];
  const report = vi.fn().mockResolvedValue({
    closed: ["atl-in", "atl-outside"],
    updated: ["atl-also-outside"],
    ignored: 2,
    cyclePeriodDays: null,
  });
  wireType("jira", "Jira", { report, readProfile: vi.fn() }, rows);

  const summary = await service.runPass({ now: NOW });

  expect(mocks.deleteAccountsByProviderAccount).toHaveBeenCalledTimes(1);
  expect(mocks.deleteAccountsByProviderAccount).toHaveBeenCalledWith({
    connectorType: "jira",
    providerAccountId: "atl-in",
  });
  expect(mocks.updateAccountProfile).not.toHaveBeenCalled();
  // 1 closed-outside + 1 updated-outside + report.ignored (2) = 4.
  expect(summary).toMatchObject({ closed: 1, updated: 0, ignored: 4 });
});

// (h) fail-safe scrubs rows unreported for two cycles, not rows within one.
it("scrubs rows unreported for two cycles and leaves rows within one", async () => {
  const rows: Row[] = [
    row({
      id: "row-old",
      providerAccountId: "atl-old",
      status: "reauth_required",
      retrievedAt: daysAgo(30),
      reportedAt: daysAgo(20),
    }),
    row({
      id: "row-recent",
      providerAccountId: "atl-recent",
      status: "reauth_required",
      retrievedAt: daysAgo(30),
      reportedAt: daysAgo(5),
    }),
    row({
      id: "row-never",
      providerAccountId: "atl-never",
      status: "reauth_required",
      retrievedAt: daysAgo(30),
      reportedAt: null,
    }),
  ];
  const report = vi.fn().mockResolvedValue(emptyReport());
  wireType("jira", "Jira", { report, readProfile: vi.fn() }, rows);

  const summary = await service.runPass({ now: NOW });

  // No active bearer exists, so nothing is reported.
  expect(report).not.toHaveBeenCalled();
  expect(mocks.markPersonalDataReported).not.toHaveBeenCalled();
  expect(mocks.scrubAccountProfiles).toHaveBeenCalledTimes(1);
  expect(mocks.scrubAccountProfiles).toHaveBeenCalledWith({
    accountIds: ["row-old", "row-never"],
    placeholderName: "Jira",
    at: NOW,
  });
  expect(summary).toMatchObject({
    checked: 3,
    reported: 0,
    scrubbed: 2,
    skippedNoBearer: 1,
  });
});

// (i) a second runPass while one is in flight returns an empty summary at once.
it("returns an empty summary when a pass is already running", async () => {
  let release!: () => void;
  mocks.listManifests.mockReturnValue([
    { type: "jira", displayName: "Jira" },
  ] as never);
  mocks.getAdapter.mockReturnValue({
    personalData: {
      report: vi.fn().mockResolvedValue(emptyReport()),
      readProfile: vi.fn(),
    },
  } as never);
  mocks.listPersonalDataAccounts.mockReturnValue(
    new Promise<Row[]>((resolve) => {
      release = () => resolve([]);
    }),
  );

  const first = service.runPass({ now: NOW });
  const second = await service.runPass({ now: NOW });

  expect(second).toEqual(EMPTY);
  expect(mocks.listPersonalDataAccounts).toHaveBeenCalledTimes(1);

  release();
  await first;
});

// (j) a thrown repository error is caught, logged with its code, and resolves.
it("catches a repository error, logs its code, and still resolves", async () => {
  wireType("jira", "Jira", { report: vi.fn(), readProfile: vi.fn() }, []);
  mocks.listPersonalDataAccounts.mockRejectedValue(new Error("db exploded"));

  const summary = await service.runPass({ now: NOW });

  expect(summary).toMatchObject({ types: 1, failed: 1 });
  expect(mocks.error).toHaveBeenCalledWith("connector_personal_data_failed", {
    connectorType: "jira",
    code: "CONNECTOR_OPERATION_FAILED",
  });
});

// (k) no Atlassian account id, email, display name or token is ever logged.
it("never logs a provider account id, email, display name, or token", async () => {
  const SECRET_ACCOUNT = "atl-SECRET-9f3";
  const SECRET_EMAIL = "secret.person@example.com";
  const SECRET_NAME = "Secret Person";
  const SECRET_TOKEN = "bearer-SECRET-TOKEN";
  const rows: Row[] = [
    row({ id: "r-1", providerAccountId: SECRET_ACCOUNT, retrievedAt: daysAgo(2) }),
  ];
  const readProfile = vi.fn().mockResolvedValue(
    profile({
      providerAccountId: SECRET_ACCOUNT,
      email: SECRET_EMAIL,
      displayName: SECRET_NAME,
    }),
  );
  mocks.getRuntimeToken.mockResolvedValue(SECRET_TOKEN);
  const report = vi.fn().mockResolvedValue({
    closed: [],
    updated: [SECRET_ACCOUNT],
    ignored: 0,
    cyclePeriodDays: null,
  });
  wireType("jira", "Jira", { report, readProfile }, rows);

  await service.runPass({ now: NOW });

  // The pass was logged (so the assertion below is not vacuous).
  expect(mocks.info).toHaveBeenCalledWith(
    "connector_personal_data_pass",
    expect.any(Object),
  );
  const logged = JSON.stringify([
    ...mocks.info.mock.calls,
    ...mocks.warn.mock.calls,
    ...mocks.error.mock.calls,
  ]);
  for (const secret of [
    SECRET_ACCOUNT,
    SECRET_EMAIL,
    SECRET_NAME,
    SECRET_TOKEN,
  ]) {
    expect(logged).not.toContain(secret);
  }
});

// A bearer deleted earlier in the pass (a `closed` id used as the bearer) must
// not break the next batch: candidates are recomputed after each deletion.
it("recomputes bearers after a deletion so a closed bearer does not break the next batch", async () => {
  const rows: Row[] = [];
  for (let i = 0; i < 91; i++) {
    rows.push(
      row({
        id: `r-${String(i).padStart(3, "0")}`,
        providerAccountId: `atl-${String(i).padStart(3, "0")}`,
        retrievedAt: new Date(NOW.getTime() - (100 - i) * DAY),
      }),
    );
  }
  const report = vi
    .fn()
    .mockResolvedValueOnce({
      closed: ["atl-000"], // the oldest active row is this batch's bearer
      updated: [],
      ignored: 0,
      cyclePeriodDays: null,
    })
    .mockResolvedValueOnce(emptyReport());
  wireType("jira", "Jira", { report, readProfile: vi.fn() }, rows);

  const summary = await service.runPass({ now: NOW });

  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.calls[0]?.[0].accessToken).toBe("bearer-r-000");
  // r-000 was deleted, so the next batch picks the next-oldest active row.
  expect(report.mock.calls[1]?.[0].accessToken).toBe("bearer-r-001");
  expect(mocks.deleteAccountsByProviderAccount).toHaveBeenCalledWith({
    connectorType: "jira",
    providerAccountId: "atl-000",
  });
  expect(summary).toMatchObject({ reported: 91, closed: 1 });
});

// Fix 1: a batch with no working bearer stops the whole type (the same bearers
// would only fail again for the next batch), logging and counting once, while
// the fail-safe sweep after the loop still runs.
it("stops the type after a bearerless batch but still runs the fail-safe", async () => {
  const rows: Row[] = [];
  for (let i = 0; i < 91; i++) {
    rows.push(
      row({
        id: `r-${String(i).padStart(3, "0")}`,
        providerAccountId: `atl-${String(i).padStart(3, "0")}`,
        retrievedAt: daysAgo(30), // past two cycles → fail-safe scrubs
        reportedAt: null,
      }),
    );
  }
  const report = vi
    .fn()
    .mockRejectedValue(
      new ConnectorError(401, "ATLASSIAN_UNAUTHORIZED", "revoked"),
    );
  wireType("jira", "Jira", { report, readProfile: vi.fn() }, rows);

  const summary = await service.runPass({ now: NOW });

  // Only the first batch is attempted: at most three bearer candidates total.
  expect(report).toHaveBeenCalledTimes(3);
  expect(mocks.getRuntimeToken).toHaveBeenCalledTimes(3);
  expect(summary.skippedNoBearer).toBe(1);
  const failedLogs = mocks.error.mock.calls.filter(
    (call) => call[0] === "connector_personal_data_failed",
  );
  expect(failedLogs).toHaveLength(1);
  expect(mocks.markPersonalDataReported).not.toHaveBeenCalled();
  expect(mocks.deleteAccountsByProviderAccount).not.toHaveBeenCalled();
  // The fail-safe sweep after the loop still scrubs rows past two cycles.
  expect(mocks.scrubAccountProfiles).toHaveBeenCalledTimes(1);
  expect(summary.scrubbed).toBe(91);
});

// Fix 2: a closed id is not marked reported until its deletion succeeds, so a
// failed deletion keeps the account due for the next pass; the other ids in the
// batch are still marked, and the failure is logged by code only.
it("keeps a closed account due when its deletion fails, still marking the others", async () => {
  const rows: Row[] = [
    row({ id: "r-a", providerAccountId: "atl-a", retrievedAt: daysAgo(2) }),
    row({ id: "r-b", providerAccountId: "atl-b", retrievedAt: daysAgo(1) }),
  ];
  const report = vi.fn().mockResolvedValue({
    closed: ["atl-a"],
    updated: [],
    ignored: 0,
    cyclePeriodDays: null,
  });
  mocks.deleteAccountsByProviderAccount.mockRejectedValue(
    new ConnectorError(500, "ATLASSIAN_DELETE_FAILED", "boom for atl-a"),
  );
  wireType("jira", "Jira", { report, readProfile: vi.fn() }, rows);

  const summary = await service.runPass({ now: NOW });

  // Only the non-closed id is stamped; the closed id stays unmarked.
  expect(mocks.markPersonalDataReported).toHaveBeenCalledTimes(1);
  expect(mocks.markPersonalDataReported).toHaveBeenCalledWith({
    connectorType: "jira",
    providerAccountIds: ["atl-b"],
    reportedAt: NOW,
  });
  expect(mocks.deleteAccountsByProviderAccount).toHaveBeenCalledWith({
    connectorType: "jira",
    providerAccountId: "atl-a",
  });
  expect(summary).toMatchObject({ closed: 0, failed: 1 });
  expect(mocks.error).toHaveBeenCalledWith("connector_personal_data_failed", {
    connectorType: "jira",
    code: "ATLASSIAN_DELETE_FAILED",
  });
  // The provider's message never reaches the log.
  expect(JSON.stringify(mocks.error.mock.calls)).not.toContain("boom for atl-a");
});

// Fix 3: the scrub branch of an `updated` row is reached when readProfile itself
// rejects (the row's token is valid), not only when the token cannot be minted.
it("scrubs an updated row whose profile read rejects even with a valid token", async () => {
  const rows: Row[] = [
    row({ id: "r-1", providerAccountId: "atl-u", retrievedAt: daysAgo(2) }),
  ];
  const readProfile = vi
    .fn()
    .mockRejectedValue(
      new ConnectorError(500, "ATLASSIAN_PROFILE_FAILED", "me endpoint down"),
    );
  const report = vi.fn().mockResolvedValue({
    closed: [],
    updated: ["atl-u"],
    ignored: 0,
    cyclePeriodDays: null,
  });
  wireType("jira", "Jira", { report, readProfile }, rows);

  const summary = await service.runPass({ now: NOW });

  expect(readProfile).toHaveBeenCalledTimes(1);
  expect(mocks.updateAccountProfile).not.toHaveBeenCalled();
  expect(mocks.scrubAccountProfiles).toHaveBeenCalledWith({
    accountIds: ["r-1"],
    placeholderName: "Jira",
    at: NOW,
  });
  expect(summary).toMatchObject({ updated: 1, scrubbed: 1 });
});
