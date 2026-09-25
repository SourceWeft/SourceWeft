import type { SourceConnector } from "@sourceweft/sdk";
import { describe, expect, test } from "vitest";
import { connectorCatalog, connectorCatalogForAvailableTypes } from "./catalog";
import { getCatalogStatus } from "./components";

test("catalog lists only implemented connectors", () => {
  expect(
    connectorCatalogForAvailableTypes(["notion", "gmail"]).map(
      (item) => item.id,
    ),
  ).toEqual(["notion", "gmail"]);
});

test("Gmail stays hidden in the catalog until the backend registers it", () => {
  expect(
    connectorCatalogForAvailableTypes(["notion"]).map((item) => item.id),
  ).toEqual(["notion"]);
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
