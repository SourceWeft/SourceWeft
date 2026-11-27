import type { SourceConnector } from "@sourceweft/sdk";
import { createTranslator } from "next-intl";
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
  ).toEqual(["notion", "gmail", "google_drive", "dropbox", "github", "linear"]);
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

describe("zotero catalog entry", () => {
  const zotero = connectorCatalog.find((item) => item.id === "zotero")!;

  test("is hidden until the backend registers the type", () => {
    expect(
      connectorCatalogForAvailableTypes(["notion", "rss"]).map((i) => i.id),
    ).not.toContain("zotero");
    expect(
      connectorCatalogForAvailableTypes(["notion", "zotero"]).map((i) => i.id),
    ).toContain("zotero");
  });

  test("is the add-only api key entry", () => {
    expect(zotero).toMatchObject({
      id: "zotero",
      name: "Zotero",
      category: "Knowledge & Docs",
      requiresBackendRegistration: true,
      isIndexable: true,
      supportsActions: false,
      supportsPeriodicSync: true,
      supportsWebhook: false,
      addMode: "api_key",
      capabilities: ["Collections", "Notes and annotations", "Scheduled sync"],
    });
    expect(zotero.icon).toBeDefined();
    expect(zotero.postOAuthMode).toBeUndefined();
  });

  test("never shows as connected, however many connectors exist", () => {
    const connectors = ["z1", "z2"].map((id) => ({
      id,
      name: `Zotero ${id}`,
      status: "active" as const,
      meta: "",
      raw: {
        id,
        connectorType: "zotero",
        status: "active",
        configJson: { libraryType: "user", libraryId: "1", items: [] },
        lastError: null,
        lastIndexedAt: null,
      } as unknown as SourceConnector,
    }));
    expect(getCatalogConnector(zotero, connectors)).toBeNull();
  });

  const ZOTERO_READINESS_REASONS = [
    "reauth_required",
    "library_not_accessible",
    "library_not_found",
    "rate_limited",
    "unreachable",
    "blocked_endpoint",
    "config_invalid",
  ];

  for (const catalogName of ["en", "zh-CN"] as const) {
    const messages = (catalogName === "en" ? en : zhCN) as unknown as {
      dashboardSourcesHub: {
        connectors: {
          zotero: {
            dialog: Record<string, string>;
            readiness: Record<string, string>;
            rotate: Record<string, string>;
            libraryIdHintPersonal: string;
            libraryIdHintGroup: string;
            apiKeyHint: string;
          };
          detail: Record<string, string>;
          selection: { byType: Record<string, Record<string, unknown>> };
        };
      };
    };

    test(`${catalogName} has the Zotero copy keys`, () => {
      const {
        zotero: copy,
        detail,
        selection,
      } = messages.dashboardSourcesHub.connectors;
      expect(copy.libraryIdHintPersonal?.trim()).toBeTruthy();
      expect(copy.libraryIdHintGroup?.trim()).toBeTruthy();
      expect(copy.apiKeyHint).toContain("zotero.org/settings/keys");
      expect(copy.dialog.check?.trim()).toBeTruthy();
      expect(copy.dialog.add?.trim()).toBeTruthy();
      expect(copy.dialog.notesAccessWarning?.trim()).toBeTruthy();
      expect(copy.rotate.save?.trim()).toBeTruthy();
      for (const reason of ZOTERO_READINESS_REASONS) {
        expect(copy.readiness[reason]?.trim(), reason).toBeTruthy();
      }
      expect(detail.availableAddApiKey?.trim()).toBeTruthy();
      expect(selection.byType.zotero).toBeDefined();
    });
  }
});

describe("discourse catalog entry", () => {
  const discourse = connectorCatalog.find((item) => item.id === "discourse")!;

  test("is hidden until the backend registers the type", () => {
    expect(
      connectorCatalogForAvailableTypes(["notion", "rss"]).map((i) => i.id),
    ).not.toContain("discourse");
    expect(
      connectorCatalogForAvailableTypes(["notion", "discourse"]).map(
        (i) => i.id,
      ),
    ).toContain("discourse");
  });

  test("is the add-only forum address entry", () => {
    expect(discourse).toMatchObject({
      id: "discourse",
      name: "Discourse",
      category: "Knowledge & Docs",
      requiresBackendRegistration: true,
      isIndexable: true,
      supportsActions: false,
      supportsPeriodicSync: true,
      supportsWebhook: false,
      addMode: "forum_url",
      capabilities: [
        "Categories and topics",
        "Post-level links",
        "Scheduled sync",
      ],
    });
    expect(discourse.icon).toBeDefined();
    expect(discourse.postOAuthMode).toBeUndefined();
  });

  test("never shows as connected, however many forums exist", () => {
    const connectors = ["d1", "d2"].map((id) => ({
      id,
      name: `Forum ${id}`,
      status: "active" as const,
      meta: "",
      raw: {
        id,
        connectorType: "discourse",
        status: "active",
        configJson: { forumUrl: "https://forum.example.com", items: [] },
        lastError: null,
        lastIndexedAt: null,
      } as unknown as SourceConnector,
    }));
    expect(getCatalogConnector(discourse, connectors)).toBeNull();
  });

  const DISCOURSE_READINESS_REASONS = [
    "config_invalid",
    "selection_required",
    "login_required",
    "not_a_discourse_site",
    "forum_unreachable",
    "blocked_endpoint",
    "rate_limited",
  ];

  for (const catalogName of ["en", "zh-CN"] as const) {
    const messages = (catalogName === "en" ? en : zhCN) as unknown as {
      dashboardSourcesHub: {
        connectors: {
          discourse: {
            dialog: Record<string, string>;
            readiness: Record<string, string>;
            forumUrlHint: string;
            refreshLightHint: string;
            refreshDeepHint: string;
          };
          detail: Record<string, string>;
          selection: {
            byType: Record<
              string,
              {
                kinds: Record<string, string>;
                disabledReason: Record<string, string>;
                empty: string;
              }
            >;
          };
        };
      };
    };

    test(`${catalogName} has the Discourse copy keys`, () => {
      const {
        discourse: copy,
        detail,
        selection,
      } = messages.dashboardSourcesHub.connectors;
      expect(copy.forumUrlHint?.trim()).toBeTruthy();
      expect(copy.refreshLightHint?.trim()).toBeTruthy();
      expect(copy.refreshDeepHint?.trim()).toBeTruthy();
      for (const key of [
        "title",
        "privateNote",
        "check",
        "add",
        "invalidUrl",
      ]) {
        expect(copy.dialog[key]?.trim(), key).toBeTruthy();
      }
      for (const reason of DISCOURSE_READINESS_REASONS) {
        expect(copy.readiness[reason]?.trim(), reason).toBeTruthy();
      }
      expect(detail.availableAddForum?.trim()).toBeTruthy();
      const byType = selection.byType.discourse!;
      expect(byType.kinds.category?.trim()).toBeTruthy();
      expect(byType.kinds.topic?.trim()).toBeTruthy();
      expect(byType.disabledReason.restricted?.trim()).toBeTruthy();
      expect(byType.empty?.trim()).toBeTruthy();
    });
  }
});

describe("wordpress catalog entry", () => {
  const wordpress = connectorCatalog.find((item) => item.id === "wordpress")!;
  const wordpressLogin = connectorCatalog.find(
    (item) => item.id === "wordpress_login",
  )!;

  test("one picker card, shown only once the backend registers the type", () => {
    expect(
      connectorCatalogForAvailableTypes(["notion", "rss"]).map((i) => i.id),
    ).not.toContain("wordpress");
    const ids = connectorCatalogForAvailableTypes([
      "notion",
      "wordpress",
      "wordpress_login",
    ]).map((i) => i.id);
    expect(ids.filter((id) => id === "wordpress")).toEqual(["wordpress"]);
    // The login type is never its own picker card, even when registered.
    expect(ids).not.toContain("wordpress_login");
  });

  test("the public card is the add-only site entry", () => {
    expect(wordpress).toMatchObject({
      id: "wordpress",
      name: "WordPress",
      category: "Knowledge & Docs",
      requiresBackendRegistration: true,
      isIndexable: true,
      supportsActions: false,
      supportsPeriodicSync: true,
      supportsWebhook: false,
      addMode: "site_url",
      capabilities: ["Posts and pages", "Categories", "Scheduled sync"],
    });
    expect(wordpress.icon).toBeDefined();
    expect(wordpress.hiddenInPicker).toBeUndefined();
    expect(wordpress.postOAuthMode).toBeUndefined();
  });

  test("the login type is a hidden entry that still resolves name and icon for its rows", () => {
    expect(wordpressLogin).toMatchObject({
      id: "wordpress_login",
      name: "WordPress",
      hiddenInPicker: true,
      requiresBackendRegistration: true,
      // `credential` addMode routes a reauth to the rotate dialog.
      addMode: "credential",
    });
    expect(wordpressLogin.icon).toBe(wordpress.icon);
  });

  test("neither WordPress type ever shows as connected, however many connectors exist", () => {
    for (const type of ["wordpress", "wordpress_login"] as const) {
      const entry = connectorCatalog.find((item) => item.id === type)!;
      const connectors = ["a", "b"].map((id) => ({
        id,
        name: `WordPress ${id}`,
        status: "active" as const,
        meta: "",
        raw: {
          id,
          connectorType: type,
          status: "active",
          configJson: { siteUrl: "https://blog.example.com", items: [] },
          lastError: null,
          lastIndexedAt: null,
        } as unknown as SourceConnector,
      }));
      expect(getCatalogConnector(entry, connectors)).toBeNull();
    }
  });

  const WORDPRESS_READINESS_REASONS = [
    "config_invalid",
    "unreachable",
    "not_a_wordpress_site",
    "rest_disabled",
    "login_required",
    "reauth_required",
    "insufficient_permission",
    "blocked_endpoint",
    "rate_limited",
  ];

  for (const catalogName of ["en", "zh-CN"] as const) {
    const messages = (catalogName === "en" ? en : zhCN) as unknown as {
      dashboardSourcesHub: {
        connectors: {
          wordpress: {
            dialog: Record<string, string>;
            readiness: Record<string, string>;
            rotate: Record<string, string>;
            siteUrlLabel: string;
            passwordLabel: string;
            appPasswordHint: string;
            includeUnpublishedWarning: string;
            wordpressComNote: string;
          };
          detail: Record<string, string>;
          selection: {
            byType: Record<string, { kinds: Record<string, string> }>;
          };
        };
      };
    };

    test(`${catalogName} has the WordPress copy keys`, () => {
      const {
        wordpress: copy,
        detail,
        selection,
      } = messages.dashboardSourcesHub.connectors;
      expect(copy.siteUrlLabel?.trim()).toBeTruthy();
      expect(copy.passwordLabel?.trim()).toBeTruthy();
      expect(copy.appPasswordHint?.trim()).toBeTruthy();
      expect(copy.includeUnpublishedWarning?.trim()).toBeTruthy();
      expect(copy.wordpressComNote?.trim()).toBeTruthy();
      for (const key of [
        "title",
        "check",
        "add",
        "invalidUrl",
        "reachableHint",
        "autoSyncHint",
      ]) {
        expect(copy.dialog[key]?.trim(), key).toBeTruthy();
      }
      // The hints must be truthful: nothing is indexed on create, and an empty
      // selection indexes all published posts and pages (R14).
      expect(copy.dialog.reachableHint).toMatch(
        catalogName === "en" ? /start a sync/i : /同步/,
      );
      expect(copy.dialog.autoSyncHint).toMatch(
        catalogName === "en" ? /does not index/i : /不会索引/,
      );
      expect(copy.rotate.save?.trim()).toBeTruthy();
      for (const reason of WORDPRESS_READINESS_REASONS) {
        expect(copy.readiness[reason]?.trim(), reason).toBeTruthy();
      }
      // The public type's login_required copy points at the login option.
      expect(detail.availableAddSite?.trim()).toBeTruthy();
      for (const type of ["wordpress", "wordpress_login"] as const) {
        const byType = selection.byType[type]!;
        for (const kind of ["type", "category", "post", "page"]) {
          expect(byType.kinds[kind]?.trim(), `${type}.${kind}`).toBeTruthy();
        }
      }
    });
  }
});

describe("nextcloud catalog entry", () => {
  const nextcloud = connectorCatalog.find((item) => item.id === "nextcloud")!;

  test("is hidden until the backend registers the type", () => {
    expect(
      connectorCatalogForAvailableTypes(["notion", "webdav"]).map((i) => i.id),
    ).not.toContain("nextcloud");
    expect(
      connectorCatalogForAvailableTypes(["notion", "nextcloud"]).map(
        (i) => i.id,
      ),
    ).toContain("nextcloud");
  });

  test("is the add-only login-flow entry", () => {
    expect(nextcloud).toMatchObject({
      id: "nextcloud",
      name: "Nextcloud",
      category: "Knowledge & Docs",
      requiresBackendRegistration: true,
      isIndexable: true,
      supportsActions: false,
      supportsPeriodicSync: true,
      supportsWebhook: false,
      addMode: "login_flow",
    });
    expect(nextcloud.icon).toBeDefined();
    expect(nextcloud.postOAuthMode).toBeUndefined();
    // No Nextcloud artwork is shipped, so the lucide icon shows instead.
    expect(nextcloud.logoIconName).toBeUndefined();
  });

  test("never shows as connected, however many connectors exist", () => {
    const connectors = ["n1", "n2"].map((id) => ({
      id,
      name: `Nextcloud ${id}`,
      status: "active" as const,
      meta: "",
      raw: {
        id,
        connectorType: "nextcloud",
        status: "active",
        configJson: {
          server: "https://cloud.example.com",
          endpoint: "https://cloud.example.com/remote.php/dav/files/alice/",
          roots: ["/"],
        },
        lastError: null,
        lastIndexedAt: null,
      } as unknown as SourceConnector,
    }));
    expect(getCatalogConnector(nextcloud, connectors)).toBeNull();
  });

  for (const catalogName of ["en", "zh-CN"] as const) {
    const messages = (catalogName === "en" ? en : zhCN) as unknown as {
      dashboardSourcesHub: {
        connectors: {
          detail: Record<string, string>;
          nextcloud: {
            serverLabel: string;
            dialog: Record<string, string>;
            reconnect: Record<string, string>;
            errors: Record<string, string>;
          };
        };
      };
    };

    const ERROR_KEYS = [
      "unreachable",
      "notNextcloud",
      "invalidResponse",
      "blockedAddress",
      "notSupported",
      "tooManyFlows",
      "reconnectMismatch",
      "alreadyConnected",
      "notAllowed",
      "notReady",
      "permissionLost",
      "pathNotFound",
      "pathForbidden",
      "expired",
      "timedOut",
      "failed",
    ];

    test(`${catalogName} has the Nextcloud copy keys`, () => {
      const { connectors } = messages.dashboardSourcesHub;
      const copy = connectors.nextcloud;
      expect(copy.serverLabel?.trim()).toBeTruthy();
      expect(copy.dialog.connect?.trim()).toBeTruthy();
      expect(copy.dialog.waitingTitle?.trim()).toBeTruthy();
      expect(copy.dialog.openAgain?.trim()).toBeTruthy();
      expect(copy.reconnect.title?.trim()).toBeTruthy();
      expect(connectors.detail.availableLoginFlow?.trim()).toBeTruthy();
      for (const key of ERROR_KEYS) {
        expect(copy.errors[key]?.trim(), key).toBeTruthy();
      }
    });
  }
});

describe("ghost catalog entry", () => {
  const ghost = connectorCatalog.find((item) => item.id === "ghost")!;

  test("one picker card, shown only once the backend registers the type", () => {
    expect(
      connectorCatalogForAvailableTypes(["notion", "rss"]).map((i) => i.id),
    ).not.toContain("ghost");
    const ids = connectorCatalogForAvailableTypes(["notion", "ghost"]).map(
      (i) => i.id,
    );
    expect(ids.filter((id) => id === "ghost")).toEqual(["ghost"]);
    expect(ids).toContain("notion");
  });

  test("is the add-only api key entry", () => {
    expect(ghost).toMatchObject({
      id: "ghost",
      name: "Ghost",
      category: "Knowledge & Docs",
      requiresBackendRegistration: true,
      isIndexable: true,
      supportsActions: false,
      supportsPeriodicSync: true,
      supportsWebhook: false,
      addMode: "api_key",
      capabilities: ["Posts and pages", "Tags", "Scheduled sync"],
    });
    expect(ghost.icon).toBeDefined();
    expect(ghost.hiddenInPicker).toBeUndefined();
    expect(ghost.postOAuthMode).toBeUndefined();
    // No Ghost artwork is shipped, so the lucide icon shows instead.
    expect(ghost.logoIconName).toBeUndefined();
  });

  test("never shows as connected, however many connectors exist", () => {
    const connectors = ["g1", "g2"].map((id) => ({
      id,
      name: `Ghost ${id}`,
      status: "active" as const,
      meta: "",
      raw: {
        id,
        connectorType: "ghost",
        status: "active",
        configJson: { siteUrl: "https://demo.ghost.io", items: [] },
        lastError: null,
        lastIndexedAt: null,
      } as unknown as SourceConnector,
    }));
    expect(getCatalogConnector(ghost, connectors)).toBeNull();
  });

  test("the card detail says Ghost, not Zotero", () => {
    const t = createTranslator({
      locale: "en",
      messages: en,
      namespace: "dashboardSourcesHub",
    }) as unknown as Parameters<typeof getCatalogStatus>[0]["t"];
    const status = getCatalogStatus(
      {
        item: ghost,
        connectors: [],
        accounts: [],
        connectorBusyById: {},
        connectorWaitingByType: {},
        webhookConfigsById: {},
        t,
      },
      "en",
    );
    expect(status.kind).toBe("available");
    expect(status.detail).toContain("Ghost");
    expect(status.detail).not.toContain("Zotero");
  });

  const GHOST_READINESS_REASONS = [
    "reauth_required",
    "not_a_ghost_site",
    "blocked_endpoint",
    "config_invalid",
    "unreachable",
    "rate_limited",
  ];

  for (const catalogName of ["en", "zh-CN"] as const) {
    const messages = (catalogName === "en" ? en : zhCN) as unknown as {
      dashboardSourcesHub: {
        connectors: {
          ghost: {
            dialog: Record<string, string>;
            readiness: Record<string, string>;
            rotate: Record<string, string>;
            siteUrlLabel: string;
            siteUrlHint: string;
            apiKeyLabel: string;
            apiKeyHint: string;
            contentNote: string;
          };
          detail: Record<string, string>;
          selection: {
            byType: Record<
              string,
              {
                kinds: Record<string, string>;
                itemsDescription: string;
                browser: Record<string, string>;
              }
            >;
          };
        };
      };
    };

    test(`${catalogName} has the Ghost copy keys`, () => {
      const {
        ghost: copy,
        detail,
        selection,
      } = messages.dashboardSourcesHub.connectors;
      for (const key of [
        "siteUrlLabel",
        "siteUrlHint",
        "apiKeyLabel",
        "apiKeyHint",
        "contentNote",
      ] as const) {
        expect(copy[key]?.trim(), key).toBeTruthy();
      }
      for (const key of [
        "title",
        "description",
        "check",
        "add",
        "invalidUrl",
        "invalidApiKey",
        "checkFailed",
        "accountConflict",
        "reachableHint",
        "autoSyncHint",
      ]) {
        expect(copy.dialog[key]?.trim(), key).toBeTruthy();
      }
      for (const key of ["title", "keyHint", "save", "failed"]) {
        expect(copy.rotate[key]?.trim(), key).toBeTruthy();
      }
      for (const reason of GHOST_READINESS_REASONS) {
        expect(copy.readiness[reason]?.trim(), reason).toBeTruthy();
      }
      expect(detail.availableAddApiKey_ghost?.trim()).toBeTruthy();
      const byType = selection.byType.ghost!;
      for (const kind of ["type", "tag", "post", "page"]) {
        expect(byType.kinds[kind]?.trim(), kind).toBeTruthy();
      }
      expect(byType.browser.note?.trim()).toBeTruthy();
      expect(byType.itemsDescription?.trim()).toBeTruthy();
    });
  }

  test("the English copy says where the URL and key are found and what is not read", () => {
    const copy = en.dashboardSourcesHub.connectors.ghost;
    const hint = `${copy.siteUrlHint} ${copy.apiKeyHint}`;
    expect(hint).toContain("Ghost Admin");
    expect(hint).toContain("Settings");
    expect(hint).toContain("Integrations");
    expect(hint).toMatch(/custom integration/i);
    expect(hint).not.toMatch(/admin api/i);
    expect(copy.contentNote).toMatch(/published/i);
    expect(copy.contentNote).toMatch(/members-only and paid/i);
    expect(copy.contentNote).toMatch(/drafts are not supported/i);
    expect(copy.readiness.blocked_endpoint).toMatch(
      /address the site itself uses/i,
    );
    expect(
      en.dashboardSourcesHub.connectors.selection.byType.ghost.browser.note,
    ).toMatch(/members-only and paid/i);
    expect(
      en.dashboardSourcesHub.connectors.selection.byType.ghost.itemsDescription,
    ).toMatch(/members-only and paid/i);
  });
});
