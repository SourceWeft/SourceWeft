import type { SourceConnector } from "@sourceweft/sdk";
import { describe, expect, test } from "vitest";
import {
  connectorCatalog,
  connectorCatalogCapabilities,
  connectorCatalogForAvailableTypes,
} from "./catalog";
import {
  formatConnectorReadinessSummary,
  getCatalogConnector,
  getCatalogStatus,
} from "./components";
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
      "linear",
    ]).map((i) => i.id),
  ).toEqual([
    "notion",
    "gmail",
    "google_drive",
    "dropbox",
    "github",
    "linear",
  ]);
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

test("jira hidden until registered", () => {
  expect(
    connectorCatalogForAvailableTypes([
      "notion",
      "gmail",
      "google_drive",
      "dropbox",
    ]).map((i) => i.id),
  ).toEqual(["notion", "gmail", "google_drive", "dropbox"]);
  const jira = connectorCatalog.find((item) => item.id === "jira");
  expect(jira).toMatchObject({
    name: "Jira",
    category: "Knowledge & Docs",
    description:
      "Let the agent search and read issues in the Jira projects you choose.",
    capabilities: ["Live search", "Issues & projects"],
    postOAuthMode: "auto_create",
    requiresBackendRegistration: true,
    isIndexable: false,
    supportsActions: true,
    supportsPeriodicSync: false,
    supportsWebhook: false,
  });
  // No Atlassian artwork is shipped, so no logoIconName.
  expect(jira?.logoIconName).toBeUndefined();
});

test("confluence hidden until registered", () => {
  expect(
    connectorCatalogForAvailableTypes([
      "notion",
      "gmail",
      "google_drive",
      "dropbox",
    ]).map((i) => i.id),
  ).toEqual(["notion", "gmail", "google_drive", "dropbox"]);
  const confluence = connectorCatalog.find((item) => item.id === "confluence");
  expect(confluence).toMatchObject({
    name: "Confluence",
    category: "Knowledge & Docs",
    description:
      "Let the agent search and read pages in the Confluence spaces and pages you choose.",
    capabilities: ["Live search", "Spaces & pages"],
    postOAuthMode: "auto_create",
    requiresBackendRegistration: true,
    isIndexable: false,
    supportsActions: true,
    supportsPeriodicSync: false,
    supportsWebhook: false,
  });
  // No Atlassian artwork is shipped, so no logoIconName.
  expect(confluence?.logoIconName).toBeUndefined();
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

test("linear stays hidden until the backend registers it", () => {
  expect(
    connectorCatalogForAvailableTypes([
      "notion",
      "gmail",
      "google_drive",
      "dropbox",
    ]).map((i) => i.id),
  ).toEqual(["notion", "gmail", "google_drive", "dropbox"]);
  const linear = connectorCatalog.find((item) => item.id === "linear");
  expect(linear).toMatchObject({
    name: "Linear",
    category: "Knowledge & Docs",
    description:
      "Search and read Linear issues and projects from the teams you choose.",
    capabilities: ["Issues & projects", "Live search"],
    postOAuthMode: "auto_create",
    requiresBackendRegistration: true,
    isIndexable: false,
    supportsActions: true,
    supportsPeriodicSync: false,
    supportsWebhook: false,
  });
  // No Linear logo file is added yet, so the lucide `icon` shows instead.
  expect(linear?.logoIconName).toBeUndefined();
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

describe("connectorCatalogCapabilities", () => {
  const gmail = connectorCatalog.find((item) => item.id === "gmail")!;

  test("keeps every capability when the manifest has not loaded yet", () => {
    expect(connectorCatalogCapabilities(gmail, undefined)).toEqual(
      gmail.capabilities,
    );
  });

  test("keeps every capability when the connector still supports indexing", () => {
    expect(connectorCatalogCapabilities(gmail, true)).toEqual(
      gmail.capabilities,
    );
  });

  test("drops only 'Optional indexing' for a tools-only connector", () => {
    expect(connectorCatalogCapabilities(gmail, false)).toEqual([
      "Search",
      "Approved sending",
    ]);
  });

  test("leaves a connector with no 'Optional indexing' chip untouched", () => {
    const notion = connectorCatalog.find((item) => item.id === "notion")!;
    expect(connectorCatalogCapabilities(notion, false)).toEqual(
      notion.capabilities,
    );
  });
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

describe("rss catalog entry", () => {
  const rss = connectorCatalog.find((item) => item.id === "rss")!;
  const t = ((key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key) as never;

  test("is hidden until the backend registers the type", () => {
    expect(
      connectorCatalogForAvailableTypes(["notion"]).map((i) => i.id),
    ).not.toContain("rss");
    expect(
      connectorCatalogForAvailableTypes(["notion", "rss"]).map((i) => i.id),
    ).toContain("rss");
  });

  test("matches the add-only feed entry", () => {
    expect(rss).toMatchObject({
      id: "rss",
      name: "RSS / Atom",
      category: "Knowledge & Docs",
      description:
        "Index posts from any public RSS or Atom feed and keep them in sync.",
      capabilities: ["Feeds", "Scheduled sync"],
      requiresBackendRegistration: true,
      isIndexable: true,
      supportsActions: false,
      supportsPeriodicSync: true,
      supportsWebhook: false,
      addMode: "feed_url",
    });
    expect(rss.icon).toBeDefined();
    expect(rss.postOAuthMode).toBeUndefined();
  });

  test("never shows as connected, however many feeds exist", () => {
    const feeds = ["f1", "f2"].map((id) => ({
      id,
      name: `Feed ${id}`,
      status: "active" as const,
      meta: "",
      raw: {
        id,
        connectorType: "rss",
        status: "active",
        configJson: { feedUrl: "https://example.com/feed.xml" },
        lastError: null,
        lastIndexedAt: null,
      } as unknown as SourceConnector,
    }));
    expect(getCatalogConnector(rss, feeds)).toBeNull();
    expect(
      getCatalogStatus(
        {
          item: rss,
          connectors: feeds,
          accounts: [],
          connectorBusyById: { f1: false },
          connectorWaitingByType: {},
          webhookConfigsById: {},
          t,
        },
        "en",
      ),
    ).toEqual({
      kind: "available",
      label: "connectors.status.available",
      detail: "connectors.detail.availableAddFeed",
    });
  });

  test("OAuth cards still resolve their connector", () => {
    const notion = connectorCatalog.find((item) => item.id === "notion")!;
    const connector = {
      id: "n1",
      name: "Notion",
      status: "active" as const,
      meta: "",
      raw: { id: "n1", connectorType: "notion" } as SourceConnector,
    };
    expect(getCatalogConnector(notion, [connector])).toBe(connector);
  });

  const READINESS_REASONS = [
    "feed_blocked_address",
    "feed_timeout",
    "feed_too_large",
    "feed_not_a_feed",
    "feed_http_error",
    "feed_unreachable",
    "feed_https_required",
  ];

  test("each feed failure reason maps to its localized summary", () => {
    for (const reason of READINESS_REASONS) {
      expect(formatConnectorReadinessSummary({ reason, message: "x" }, t)).toBe(
        `connectors.readiness.${reason}`,
      );
    }
  });

  for (const catalogName of ["en", "zh-CN"] as const) {
    const messages = (catalogName === "en" ? en : zhCN) as unknown as {
      dashboardSourcesHub: {
        connectors: {
          cta: Record<string, string>;
          detail: Record<string, string>;
          readiness: Record<string, string>;
          rss: Record<string, string>;
        };
      };
    };

    test(`${catalogName} has the RSS copy keys`, () => {
      const { connectors } = messages.dashboardSourcesHub;
      expect(connectors.cta.addFeed?.trim()).toBeTruthy();
      expect(connectors.detail.availableAddFeed?.trim()).toBeTruthy();
      expect(connectors.rss.feedUrl?.trim()).toBeTruthy();
      for (const reason of READINESS_REASONS) {
        expect(connectors.readiness[reason]?.trim(), reason).toBeTruthy();
      }
    });
  }
});

describe("webdav catalog entry", () => {
  const webdav = connectorCatalog.find((item) => item.id === "webdav")!;

  test("is hidden until the backend registers the type", () => {
    expect(
      connectorCatalogForAvailableTypes(["notion", "rss"]).map((i) => i.id),
    ).not.toContain("webdav");
    expect(
      connectorCatalogForAvailableTypes(["notion", "webdav"]).map((i) => i.id),
    ).toContain("webdav");
  });

  test("is the add-only credential entry", () => {
    expect(webdav).toMatchObject({
      id: "webdav",
      name: "WebDAV",
      category: "Knowledge & Docs",
      requiresBackendRegistration: true,
      isIndexable: true,
      supportsActions: false,
      supportsPeriodicSync: true,
      supportsWebhook: false,
      addMode: "credential",
    });
    expect(webdav.icon).toBeDefined();
    expect(webdav.postOAuthMode).toBeUndefined();
  });

  test("never shows as connected, however many connectors exist", () => {
    const connectors = ["w1", "w2"].map((id) => ({
      id,
      name: `WebDAV ${id}`,
      status: "active" as const,
      meta: "",
      raw: {
        id,
        connectorType: "webdav",
        status: "active",
        configJson: { endpoint: "https://dav.example.com", roots: ["/"] },
        lastError: null,
        lastIndexedAt: null,
      } as unknown as SourceConnector,
    }));
    expect(getCatalogConnector(webdav, connectors)).toBeNull();
  });

  const WEBDAV_READINESS_REASONS = [
    "reauth_required",
    "blocked_endpoint",
    "unreachable",
    "config_invalid",
    "path_forbidden",
    "path_not_found",
  ];

  for (const catalogName of ["en", "zh-CN"] as const) {
    const messages = (catalogName === "en" ? en : zhCN) as unknown as {
      dashboardSourcesHub: {
        connectors: {
          webdav: {
            dialog: Record<string, string>;
            readiness: Record<string, string>;
            rotate: Record<string, string>;
            endpointLabel: string;
            passwordLabel: string;
          };
        };
      };
    };

    test(`${catalogName} has the WebDAV copy keys`, () => {
      const { webdav: copy } = messages.dashboardSourcesHub.connectors;
      expect(copy.endpointLabel?.trim()).toBeTruthy();
      expect(copy.passwordLabel?.trim()).toBeTruthy();
      expect(copy.dialog.check?.trim()).toBeTruthy();
      expect(copy.dialog.add?.trim()).toBeTruthy();
      expect(copy.rotate.save?.trim()).toBeTruthy();
      for (const reason of WEBDAV_READINESS_REASONS) {
        expect(copy.readiness[reason]?.trim(), reason).toBeTruthy();
      }
    });
  }
});
