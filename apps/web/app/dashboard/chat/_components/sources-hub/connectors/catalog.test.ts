import type { SourceConnector } from "@sourceweft/sdk";
import { describe, expect, test } from "vitest";
import { connectorCatalog, connectorCatalogForAvailableTypes } from "./catalog";
import { getCatalogStatus } from "./components";
import en from "../../../../../../messages/en.json";
import zhCN from "../../../../../../messages/zh-CN.json";

test("catalog lists only implemented connectors", () => {
  expect(
    connectorCatalogForAvailableTypes([
      "notion",
      "gmail",
      "google_drive",
      "dropbox",
      "github",
    ]).map((i) => i.id),
  ).toEqual(["notion", "gmail", "google_drive", "dropbox", "github"]);
});

test("Gmail stays hidden in the catalog until the backend registers it", () => {
  expect(
    connectorCatalogForAvailableTypes(["notion"]).map((i) => i.id),
  ).toEqual(["notion"]);
});

test("Google Drive stays hidden until the backend registers it", () => {
  expect(
    connectorCatalogForAvailableTypes(["notion", "gmail"]).map((i) => i.id),
  ).toEqual(["notion", "gmail"]);
});

test("dropbox hidden until registered", () => {
  expect(
    connectorCatalogForAvailableTypes(["notion", "gmail", "google_drive"]).map(
      (i) => i.id,
    ),
  ).toEqual(["notion", "gmail", "google_drive"]);
  const dropbox = connectorCatalog.find((item) => item.id === "dropbox");
  expect(dropbox).toMatchObject({
    name: "Dropbox",
    category: "Knowledge & Docs",
    description:
      "Choose Dropbox files and folders to index and keep them in sync.",
    capabilities: ["Files & folders", "Scheduled sync"],
    postOAuthMode: "auto_create",
    requiresBackendRegistration: true,
    isIndexable: true,
    supportsActions: false,
    supportsPeriodicSync: true,
    supportsWebhook: false,
  });
});

test("Notion never depends on backend registration", () => {
  expect(connectorCatalogForAvailableTypes([]).map((i) => i.id)).toEqual([
    "notion",
  ]);
});

test("github hidden until registered", () => {
  expect(
    connectorCatalogForAvailableTypes([
      "notion",
      "gmail",
      "google_drive",
      "dropbox",
    ]).map((i) => i.id),
  ).toEqual(["notion", "gmail", "google_drive", "dropbox"]);
  const github = connectorCatalog.find((item) => item.id === "github");
  expect(github).toMatchObject({
    name: "GitHub",
    category: "Knowledge & Docs",
    description:
      "Let agents search and read issues, pull requests and discussions in the repositories you choose.",
    capabilities: ["Issues & pull requests", "Discussions", "Live search"],
    postOAuthMode: "auto_create",
    requiresBackendRegistration: true,
    logoIconName: "github",
    logoIconTone: "mono",
    isIndexable: false,
    supportsActions: true,
    supportsPeriodicSync: false,
    supportsWebhook: false,
  });
});

describe("github selection copy", () => {
  const GITHUB_SELECTION_KEYS = [
    "itemsTitle",
    "itemsDescription",
    "choose",
    "empty",
    "browser.description",
    "browser.root",
    "browser.emptyRoot",
    "kinds.account",
    "kinds.repository",
    "helpLink.add_repositories",
  ];

  function getPath(root: unknown, path: string): unknown {
    return path
      .split(".")
      .reduce<unknown>(
        (value, segment) =>
          typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)[segment]
            : undefined,
        root,
      );
  }

  for (const catalogName of ["en", "zh-CN"] as const) {
    const catalog = catalogName === "en" ? en : zhCN;
    const githubEntry = getPath(
      catalog,
      "dashboardSourcesHub.connectors.selection.byType.github",
    );

    test(`${catalogName} has all ten github selection keys`, () => {
      for (const key of GITHUB_SELECTION_KEYS) {
        const value = getPath(githubEntry, key);
        expect(typeof value, key).toBe("string");
        expect((value as string).trim().length, key).toBeGreaterThan(0);
      }
    });
  }
});

describe("sync-block-status.test.ts", () => {
  const t = ((key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key) as never;

  function statusFor(raw: Partial<SourceConnector>, status = "active") {
    const item = connectorCatalog.find((entry) => entry.id === "notion")!;
    return getCatalogStatus(
      {
        item,
        connectors: [
          {
            id: "c1",
            name: "Notion",
            status: status as "active",
            meta: "",
            raw: {
              id: "c1",
              connectorType: "notion",
              status,
              configJson: {},
              lastError: null,
              lastIndexedAt: null,
              ...raw,
            } as SourceConnector,
          },
        ],
        accounts: [],
        connectorBusyById: {},
        connectorWaitingByType: {},
        webhookConfigsById: {},
        t,
      },
      "en",
    );
  }

  const quotaBlock = {
    reason: "PAGES_LIMIT_EXCEEDED" as const,
    runId: "run_1",
    blockedAt: "2026-09-25T00:00:00.000Z",
    indexedCount: 12,
    requestedPages: 3,
    availablePages: 0,
  };

  test("a quota pause reads as a warning with progress, not an error", () => {
    expect(statusFor({ syncBlock: quotaBlock })).toEqual({
      kind: "blocked",
      label: "connectors.status.blocked",
      detail: 'connectors.syncBlock.pagesLimit {"count":12}',
    });
  });

  test("an owner who left the team gets its own explanation", () => {
    expect(
      statusFor({
        syncBlock: {
          ...quotaBlock,
          reason: "CONNECTOR_BILLING_OWNER_UNAVAILABLE",
        },
      }).detail,
    ).toBe("connectors.syncBlock.ownerUnavailable");
  });

  test("a real error or a user pause still takes precedence over a platform pause", () => {
    expect(
      statusFor({
        syncBlock: quotaBlock,
        lastError: "3 connector items failed",
      }).kind,
    ).toBe("error");
    expect(statusFor({ syncBlock: quotaBlock }, "paused").kind).toBe(
      "needs_setup",
    );
  });
});

describe("reconnect status", () => {
  const t = ((key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key) as never;
  const item = connectorCatalog.find((entry) => entry.id === "google_drive")!;

  function statusFor(input: {
    status?: "active" | "paused" | "disabled";
    accountStatus?: "active" | null;
  }) {
    const status = input.status ?? "active";
    return getCatalogStatus(
      {
        item,
        connectors: [
          {
            id: "c1",
            name: "Person",
            status,
            meta: "",
            raw: {
              id: "c1",
              connectorType: "google_drive",
              status,
              configJson: {},
              oauthAccountId: "acc-1",
              lastError: null,
              lastIndexedAt: null,
            } as SourceConnector,
          },
        ],
        accounts:
          input.accountStatus === "active"
            ? [
                {
                  id: "acc-1",
                  connectorType: "google_drive",
                  status: "active",
                } as never,
              ]
            : [],
        connectorBusyById: {},
        connectorWaitingByType: {},
        webhookConfigsById: {},
        t,
      },
      "en",
    );
  }

  test("a connector whose authorization is no longer active asks to be reconnected", () => {
    expect(statusFor({ accountStatus: null })).toEqual({
      kind: "error",
      label: "connectors.status.error",
      detail: "connectors.detail.reauthRequired",
    });
  });

  test("a paused connector with a dead authorization still asks to be reconnected", () => {
    expect(statusFor({ status: "paused", accountStatus: null }).detail).toBe(
      "connectors.detail.reauthRequired",
    );
  });

  test("a connector with an active authorization stays active", () => {
    expect(statusFor({ accountStatus: "active" }).kind).toBe("active");
  });

  test("a disabled connector reads as disabled whatever its authorization", () => {
    expect(statusFor({ status: "disabled", accountStatus: null })).toEqual({
      kind: "needs_setup",
      label: "connectors.status.disabled",
      detail: "connectors.detail.disabled",
    });
  });
});
