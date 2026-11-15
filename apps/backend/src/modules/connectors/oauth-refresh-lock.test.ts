import { beforeEach, expect, it, vi } from "vitest";
import { ConnectorError } from "./errors";
import type {
  ConnectorOAuthAccountSecretRecord,
  OAuthTokenSet,
} from "./types";

type Row = ConnectorOAuthAccountSecretRecord;
type Write =
  | { kind: "none" }
  | {
      kind: "token";
      accessTokenEncrypted: string;
      refreshTokenEncrypted?: string | null;
      expiresAt: Date | null;
      scopes?: string[];
    }
  | { kind: "status"; status: "reauth_required"; lastError: string };

const mocks = vi.hoisted(() => ({
  findAccount: vi.fn(),
  lock: vi.fn(),
  refresh: vi.fn(),
  getAdapter: vi.fn(),
  listDue: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../preview", () => ({
  previewAccessService: { isEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock("../../shared/logger", () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../shared/team-secrets", () => ({
  encryptTeamSecret: vi.fn(async (value: string) => `enc(${value})`),
  decryptTeamSecret: vi.fn(
    async (value: string | null) =>
      value?.replace(/^enc\((.*)\)$/, "$1") ?? null,
  ),
}));
vi.mock("./repository", () => ({
  consumeOAuthStateRecord: vi.fn(),
  createOAuthAccountRecord: vi.fn(),
  createOAuthStateRecord: vi.fn(),
  findOAuthAccountRecord: mocks.findAccount,
  findOAuthStateRecord: vi.fn(),
  findReauthorizableOAuthAccountRecord: vi.fn(),
  listOAuthAccountsDueForKeepAlive: mocks.listDue,
  reauthorizeOAuthAccountRecord: vi.fn(),
  updateOAuthAccountStatusRecord: vi.fn(),
  updateOAuthAccountTokenRecord: vi.fn(),
  withOAuthAccountRefreshLock: mocks.lock,
}));

import { ConnectorOAuthService } from "./oauth-service";

const stale = () => new Date(Date.now() - 1_000).toISOString();
const fresh = () => new Date(Date.now() + 3_600_000).toISOString();

function freshRow(): Row {
  return {
    id: "account-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    connectorType: "google_drive",
    providerAccountId: "provider-1",
    providerAccountEmail: "person@example.com",
    displayName: "Person",
    scopes: ["drive.file"],
    status: "active",
    expiresAt: stale(),
    lastRefreshAt: null,
    lastError: null,
    createdBy: "user-1",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    accessTokenEncrypted: "enc(a1)",
    refreshTokenEncrypted: "enc(r1)",
  };
}

const registry = { getAdapter: mocks.getAdapter };
const service = new ConnectorOAuthService(registry as never);

const input = {
  teamId: "team-1",
  workspaceId: "workspace-1",
  accountId: "account-1",
  connectorType: "google_drive",
};

// The default single-account fixture used by most tests below.
const DEFAULT_ACCOUNT_ID = "account-1";

let row: Row | null;
let writes: Write[] = [];
let queue: Promise<void> = Promise.resolve();

// Rows for additional accounts (keyed by account id), used by the keep-alive
// tests that need several accounts locked in one pass. `DEFAULT_ACCOUNT_ID`
// always resolves through `row`/`queue` above, unchanged from before.
let extraRows: Map<string, Row | null>;
let extraQueues: Map<string, Promise<void>>;

function getRowFor(id: string): Row | null {
  return id === DEFAULT_ACCOUNT_ID ? row : extraRows.get(id) ?? null;
}

function setRowFor(id: string, value: Row | null) {
  if (id === DEFAULT_ACCOUNT_ID) {
    row = value;
  } else {
    extraRows.set(id, value);
  }
}

function applyWrite(id: string, write: Write) {
  const current = getRowFor(id);
  if (!current) return;
  if (write.kind === "token") {
    setRowFor(id, {
      ...current,
      accessTokenEncrypted: write.accessTokenEncrypted,
      refreshTokenEncrypted:
        write.refreshTokenEncrypted === undefined
          ? current.refreshTokenEncrypted
          : write.refreshTokenEncrypted,
      expiresAt: write.expiresAt ? write.expiresAt.toISOString() : null,
      scopes: write.scopes ?? current.scopes,
      status: "active",
      lastError: null,
    });
  } else if (write.kind === "status") {
    setRowFor(id, { ...current, status: write.status, lastError: write.lastError });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  row = freshRow();
  writes = [];
  queue = Promise.resolve();
  extraRows = new Map();
  extraQueues = new Map();

  mocks.findAccount.mockImplementation(async () =>
    row ? { ...row } : null,
  );
  mocks.getAdapter.mockReturnValue({ refreshOAuthToken: mocks.refresh });
  mocks.lock.mockImplementation(
    async (
      lockInput: { accountId: string },
      decide: (
        locked: Row | null,
      ) => Promise<{ write: Write; result: unknown }>,
    ) => {
      const id = lockInput.accountId;
      const run = async () => {
        const current = getRowFor(id);
        const snapshot = current ? { ...current } : null;
        const { write, result } = await decide(snapshot);
        applyWrite(id, write);
        writes.push(write);
        return result;
      };
      const priorQueue =
        id === DEFAULT_ACCOUNT_ID
          ? queue
          : extraQueues.get(id) ?? Promise.resolve();
      const turn = priorQueue.then(run, run);
      const settled = turn.then(
        () => undefined,
        () => undefined,
      );
      if (id === DEFAULT_ACCOUNT_ID) {
        queue = settled;
      } else {
        extraQueues.set(id, settled);
      }
      return turn;
    },
  );
});

it("ten concurrent callers share one provider refresh", async () => {
  row!.expiresAt = stale();
  mocks.refresh.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: new Date(Date.now() + 3_600_000),
    } satisfies OAuthTokenSet;
  });

  const tokens = await Promise.all(
    Array.from({ length: 10 }, () => service.getRuntimeToken(input)),
  );

  expect(tokens).toEqual(Array(10).fill("a2"));
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(mocks.refresh).toHaveBeenCalledWith({
    refreshToken: "r1",
    scopes: row!.scopes,
  });
  expect(mocks.lock).toHaveBeenCalledTimes(1);
});

it("a caller that finds a fresh token under the lock does not call the provider", async () => {
  // findOAuthAccountRecord returns a stale copy; the locked row is already
  // fresh with access "enc(a2)" (another caller refreshed it first).
  row = { ...freshRow(), expiresAt: fresh(), accessTokenEncrypted: "enc(a2)" };
  mocks.findAccount.mockResolvedValue({ ...row, expiresAt: stale() });

  expect(await service.getRuntimeToken(input)).toBe("a2");
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(writes).toEqual([{ kind: "none" }]);
});

it("uses the refresh token read under the lock", async () => {
  // pre-lock copy has "enc(r-old)", the locked row has "enc(r-new)" and is
  // stale, so the provider must be called with the token read under the lock.
  row = {
    ...freshRow(),
    expiresAt: stale(),
    refreshTokenEncrypted: "enc(r-new)",
  };
  mocks.findAccount.mockResolvedValue({
    ...row,
    expiresAt: stale(),
    refreshTokenEncrypted: "enc(r-old)",
  });
  mocks.refresh.mockResolvedValue({
    accessToken: "a2",
    expiresAt: new Date(Date.now() + 3_600_000),
  } satisfies OAuthTokenSet);

  await service.getRuntimeToken(input);

  expect(mocks.refresh).toHaveBeenCalledWith({
    refreshToken: "r-new",
    scopes: row.scopes,
  });
});

it("stores a rotated refresh token, keeps it when undefined, clears it when null", async () => {
  mocks.refresh.mockResolvedValueOnce({
    accessToken: "a2",
    refreshToken: "r2",
    expiresAt: new Date(Date.now() + 3_600_000),
  } satisfies OAuthTokenSet);
  await service.getRuntimeToken(input);
  expect(writes[0]).toMatchObject({ refreshTokenEncrypted: "enc(r2)" });

  row = freshRow();
  writes = [];
  mocks.refresh.mockResolvedValueOnce({
    accessToken: "a2",
    expiresAt: new Date(Date.now() + 3_600_000),
  } satisfies OAuthTokenSet);
  await service.getRuntimeToken(input);
  expect(writes[0]).toMatchObject({ refreshTokenEncrypted: undefined });

  row = freshRow();
  writes = [];
  mocks.refresh.mockResolvedValueOnce({
    accessToken: "a2",
    refreshToken: null,
    expiresAt: new Date(Date.now() + 3_600_000),
  } satisfies OAuthTokenSet);
  await service.getRuntimeToken(input);
  expect(writes[0]).toMatchObject({ refreshTokenEncrypted: null });
});

it("a provider refusal marks the account and throws CONNECTOR_REAUTH_REQUIRED", async () => {
  mocks.refresh.mockRejectedValue(
    Object.assign(new Error("invalid_grant"), { statusCode: 400 }),
  );

  await expect(service.getRuntimeToken(input)).rejects.toMatchObject({
    statusCode: 409,
    code: "CONNECTOR_REAUTH_REQUIRED",
  });
  expect(writes).toEqual([
    { kind: "status", status: "reauth_required", lastError: "invalid_grant" },
  ]);
});

it.each([
  ["429", Object.assign(new Error("slow down"), { statusCode: 429 })],
  ["503", Object.assign(new Error("unavailable"), { statusCode: 503 })],
  ["network", new TypeError("fetch failed")],
])("a %s failure leaves the account untouched", async (_name, error) => {
  mocks.refresh.mockRejectedValue(error);

  await expect(service.getRuntimeToken(input)).rejects.toBeInstanceOf(Error);
  expect(writes).toEqual([]);
});

it("a provider call that never answers times out without marking the account", async () => {
  vi.useFakeTimers();
  try {
    mocks.refresh.mockReturnValue(new Promise(() => {}));
    const pending = service.getRuntimeToken(input);
    const assertion = expect(pending).rejects.toMatchObject({
      statusCode: 503,
      code: "CONNECTOR_OAUTH_REFRESH_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(writes).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("a lock wait timeout surfaces as CONNECTOR_OAUTH_REFRESH_BUSY and marks nothing", async () => {
  mocks.lock.mockRejectedValueOnce(
    new ConnectorError(
      503,
      "CONNECTOR_OAUTH_REFRESH_BUSY",
      "Connector token refresh is busy",
    ),
  );

  await expect(service.getRuntimeToken(input)).rejects.toMatchObject({
    statusCode: 503,
    code: "CONNECTOR_OAUTH_REFRESH_BUSY",
  });
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
});

// Review Focus 1
it("an unregistered adapter does not touch the account", async () => {
  mocks.getAdapter.mockImplementation(() => {
    throw new ConnectorError(
      404,
      "CONNECTOR_ADAPTER_NOT_FOUND",
      "Connector adapter 'google_drive' is not registered",
    );
  });

  await expect(service.getRuntimeToken(input)).rejects.toMatchObject({
    code: "CONNECTOR_ADAPTER_NOT_FOUND",
  });
  expect(mocks.lock).not.toHaveBeenCalled();
});

// Review Focus 2
it("an account marked or deleted while waiting is reported without a provider call", async () => {
  row = freshRow();
  const markedUnavailable = service.getRuntimeToken(input);
  row.status = "reauth_required";
  await expect(markedUnavailable).rejects.toMatchObject({
    statusCode: 409,
    code: "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE",
  });

  row = freshRow();
  const deleted = service.getRuntimeToken(input);
  row = null;
  await expect(deleted).rejects.toMatchObject({
    statusCode: 404,
    code: "CONNECTOR_OAUTH_ACCOUNT_NOT_FOUND",
  });

  expect(mocks.refresh).not.toHaveBeenCalled();
});

// Review Focus 3
it("a failed refresh does not poison the next call", async () => {
  mocks.refresh
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValueOnce({
      accessToken: "a2",
      expiresAt: new Date(Date.now() + 3_600_000),
    } satisfies OAuthTokenSet);

  await expect(service.getRuntimeToken(input)).rejects.toBeInstanceOf(Error);
  expect(await service.getRuntimeToken(input)).toBe("a2");
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
});

// Review Focus 5
it("an undecryptable refresh token marks the account", async () => {
  row!.refreshTokenEncrypted = null;

  await expect(service.getRuntimeToken(input)).rejects.toMatchObject({
    statusCode: 409,
    code: "CONNECTOR_REAUTH_REQUIRED",
  });
  expect(writes).toEqual([
    {
      kind: "status",
      status: "reauth_required",
      lastError: "Refresh token is unavailable",
    },
  ]);
});

it("an account without an expiry is returned as stored", async () => {
  row!.expiresAt = null;

  expect(await service.getRuntimeToken(input)).toBe("a1");
  expect(mocks.lock).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
});

// -- refreshIdleAccounts (background keep-alive) ---------------------------

const KEEP_ALIVE_MIN_AGE_MS = 7 * 24 * 60 * 60_000;
const now = new Date("2026-11-15T00:00:00.000Z");
const eightDaysAgo = new Date(
  now.getTime() - 8 * 24 * 60 * 60_000,
).toISOString();

function keepAliveRow(id: string, overrides: Partial<Row> = {}): Row {
  return {
    ...freshRow(),
    id,
    accessTokenEncrypted: `enc(a-${id})`,
    refreshTokenEncrypted: `enc(r-${id})`,
    lastRefreshAt: null,
    createdAt: eightDaysAgo,
    expiresAt: fresh(),
    ...overrides,
  };
}

function keepAliveCandidate(id: string, connectorType: string) {
  return { id, teamId: "team-1", workspaceId: "workspace-1", connectorType };
}

it("keep-alive refreshes each due account through the locked path and counts outcomes", async () => {
  const candidates = [
    keepAliveCandidate("acct-a", "type_a"), // refreshes
    keepAliveCandidate("acct-b", "type_b"), // already fresh under the lock
    keepAliveCandidate("acct-c", "type_c"), // refused by the provider
    keepAliveCandidate("acct-d", "type_d"), // adapter not registered
    keepAliveCandidate("acct-e", "type_e"), // transport failure
  ];
  mocks.listDue.mockResolvedValue(candidates);

  extraRows.set("acct-a", keepAliveRow("acct-a"));
  extraRows.set(
    "acct-b",
    keepAliveRow("acct-b", { lastRefreshAt: now.toISOString() }),
  );
  extraRows.set("acct-c", keepAliveRow("acct-c"));
  extraRows.set("acct-d", keepAliveRow("acct-d"));
  extraRows.set("acct-e", keepAliveRow("acct-e"));

  const refreshers: Record<string, () => Promise<OAuthTokenSet>> = {
    type_a: async () => ({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: new Date(now.getTime() + 3_600_000),
    }),
    type_c: async () => {
      throw Object.assign(new Error("invalid_grant"), { statusCode: 400 });
    },
    type_e: async () => {
      throw new TypeError("fetch failed");
    },
  };
  mocks.getAdapter.mockImplementation((connectorType: string) => {
    if (connectorType === "type_d") {
      throw new ConnectorError(
        404,
        "CONNECTOR_ADAPTER_NOT_FOUND",
        "Connector adapter 'type_d' is not registered",
      );
    }
    const refresher = refreshers[connectorType];
    return {
      refreshOAuthToken:
        refresher ??
        (async () => {
          throw new Error(`unexpected refresh call for ${connectorType}`);
        }),
    };
  });

  expect(await service.refreshIdleAccounts({ now })).toEqual({
    checked: 5,
    refreshed: 1,
    alreadyFresh: 1,
    reauthRequired: 1,
    skipped: 1,
    failed: 1,
  });
  expect(mocks.listDue).toHaveBeenCalledWith({
    refreshedBefore: new Date(now.getTime() - KEEP_ALIVE_MIN_AGE_MS),
    limit: 50,
  });
  expect(mocks.lock).toHaveBeenCalledTimes(4); // not acct-d
  expect(mocks.warn).toHaveBeenCalledTimes(1);
  expect(mocks.warn).toHaveBeenCalledWith("connector_token_keep_alive_failed", {
    accountId: "acct-e",
    connectorType: "type_e",
    code: "CONNECTOR_OPERATION_FAILED",
  });
  expect(mocks.info).toHaveBeenCalledWith("connector_token_keep_alive", {
    checked: 5,
    refreshed: 1,
    alreadyFresh: 1,
    reauthRequired: 1,
    skipped: 1,
    failed: 1,
  });
});

// Review Focus 1
it("keep-alive never marks an account whose connector is switched off", async () => {
  mocks.listDue.mockResolvedValue([keepAliveCandidate("acct-d", "type_d")]);
  const dRow = keepAliveRow("acct-d");
  extraRows.set("acct-d", dRow);
  mocks.getAdapter.mockImplementation(() => {
    throw new ConnectorError(
      404,
      "CONNECTOR_ADAPTER_NOT_FOUND",
      "Connector adapter 'type_d' is not registered",
    );
  });

  expect(await service.refreshIdleAccounts({ now })).toEqual({
    checked: 1,
    refreshed: 0,
    alreadyFresh: 0,
    reauthRequired: 0,
    skipped: 1,
    failed: 0,
  });
  expect(mocks.lock).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
  expect(extraRows.get("acct-d")).toEqual(dRow);
  expect(mocks.warn).not.toHaveBeenCalled();
});

// Review Focus 4
it("keep-alive decides freshness by lastRefreshAt, not by expiry", async () => {
  mocks.listDue.mockResolvedValue([
    keepAliveCandidate("acct-f", "type_f"),
    keepAliveCandidate("acct-g", "type_g"),
  ]);
  extraRows.set(
    "acct-f",
    keepAliveRow("acct-f", { expiresAt: null, lastRefreshAt: eightDaysAgo }),
  );
  extraRows.set(
    "acct-g",
    keepAliveRow("acct-g", {
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      lastRefreshAt: eightDaysAgo,
    }),
  );
  const refresh = vi
    .fn()
    .mockResolvedValue({ accessToken: "new-token" } satisfies OAuthTokenSet);
  mocks.getAdapter.mockImplementation(() => ({ refreshOAuthToken: refresh }));

  expect(await service.refreshIdleAccounts({ now })).toEqual({
    checked: 2,
    refreshed: 2,
    alreadyFresh: 0,
    reauthRequired: 0,
    skipped: 0,
    failed: 0,
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(writes).toEqual([
    expect.objectContaining({ kind: "token", expiresAt: null }),
    expect.objectContaining({ kind: "token" }),
  ]);
});

// Ruling 2
it("keep-alive counts an account that disappeared or was marked meanwhile as skipped", async () => {
  mocks.listDue.mockResolvedValue([
    keepAliveCandidate("acct-gone", "type_gone"),
    keepAliveCandidate("acct-unavailable", "type_unavailable"),
  ]);
  extraRows.set("acct-gone", null);
  extraRows.set(
    "acct-unavailable",
    keepAliveRow("acct-unavailable", { status: "reauth_required" }),
  );
  const refresh = vi.fn();
  mocks.getAdapter.mockImplementation(() => ({ refreshOAuthToken: refresh }));

  expect(await service.refreshIdleAccounts({ now })).toEqual({
    checked: 2,
    refreshed: 0,
    alreadyFresh: 0,
    reauthRequired: 0,
    skipped: 2,
    failed: 0,
  });
  expect(refresh).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
  expect(mocks.warn).not.toHaveBeenCalled();
});

it("keep-alive does not log a pass when there is nothing to check", async () => {
  mocks.listDue.mockResolvedValue([]);

  expect(await service.refreshIdleAccounts({ now })).toEqual({
    checked: 0,
    refreshed: 0,
    alreadyFresh: 0,
    reauthRequired: 0,
    skipped: 0,
    failed: 0,
  });
  expect(mocks.info).not.toHaveBeenCalled();
});
