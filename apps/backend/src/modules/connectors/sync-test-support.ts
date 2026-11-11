import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { BillingError } from "@sourceweft/contracts/billing-runtime";
import type { ContentBillingPort } from "../content/billing-port";
import { ConnectorItemSkipError } from "./types";
import type {
  ConnectorAdapter,
  ConnectorItem,
  ConnectorItemSkipReason,
} from "./types";

/**
 * Shared harness for the connector sync-orchestrator database suites: an
 * isolated-database test builds its own clone, then wires this fake billing,
 * fake adapter and stubbed indexing around a real {@link ConnectorSyncOrchestrator}.
 * `sync-quota.database.test.ts` and `sync-file-extract.database.test.ts` share
 * it so both exercise the real orchestrator against the same seams.
 */
export type ConnectorTestContext = {
  schema: typeof import("@sourceweft/db");
  connectorRuntime: typeof import("./index");
  syncRunRepo: typeof import("./repository/sync-run");
  indexing: typeof import("../sources/indexing-service");
};

export const OWNER = "owner-user";
export const TRIGGER = "trigger-user";
export const PAGE_CHARS = 4_000; // DEFAULT_TOKENS_PER_STANDARD_PAGE (1000) × 4 chars

export type Pages = {
  available: number;
  cycleCapacity: number;
  enforced: boolean;
};

export type IndexCall = { sourceId: string; userId: string };

/** The content `extract()` yields for a test item: text, a downloadable file,
 * or a thrown skip. Default is text so the quota suite is unchanged. */
type ExtractShape =
  | { mode: "text" }
  | { mode: "file"; fileName: string; fileMimeType: string }
  | { mode: "skip"; reason: ConnectorItemSkipReason };

export type TestConnectorItem = ConnectorItem & {
  body: string;
  extractShape: ExtractShape;
};

/** Billing that answers admission from `pages`, which the fake indexer drains. */
export function fakeBilling(initial: Partial<Pages> = {}) {
  const pages: Pages = {
    available: 100,
    cycleCapacity: 100,
    enforced: true,
    ...initial,
  };
  const port = {
    getExecutionState: vi.fn(async () => ({
      kind: "metered" as const,
      mode: "enforced" as const,
      availableCredits: 100,
      consumedThisCycle: 0,
      ingestionPages: { ...pages },
    })),
    settleModelUsage: vi.fn(),
    meterIngestion: vi.fn(),
    reconcileProviderCost: vi.fn(),
  } as unknown as ContentBillingPort;
  return { pages, port };
}

export function item(
  externalId: string,
  chars = 20,
  overrides: {
    body?: string;
    title?: string;
    mimeType?: string | null;
    contentHash?: string | null;
    externalUpdatedAt?: Date | null;
    metadata?: Record<string, unknown>;
    extractShape?: ExtractShape;
  } = {},
): TestConnectorItem {
  return {
    externalId,
    externalUri: `https://example.com/${externalId}`,
    title: overrides.title ?? externalId,
    mimeType: overrides.mimeType ?? "text/plain",
    sizeBytes: null,
    externalUpdatedAt:
      overrides.externalUpdatedAt ?? new Date("2026-09-01T00:00:00.000Z"),
    contentHash: overrides.contentHash ?? null,
    metadata: overrides.metadata ?? {},
    body: overrides.body ?? "x".repeat(chars),
    extractShape: overrides.extractShape ?? { mode: "text" },
  };
}

/**
 * Cursor pages that resume from page N on continuation. `reconcile` makes the
 * last page a full reconciling scan (archives sources the run did not see).
 * `extract` honours each item's shape: text, a file descriptor whose download
 * returns the body as a plain-text buffer, or a thrown `ConnectorItemSkipError`.
 */
export function fakeAdapter(
  pagesOf: Array<TestConnectorItem[]>,
  options: { reconcile?: boolean } = {},
) {
  const extract = vi.fn(async (input: { item: ConnectorItem }) => {
    const found = pagesOf
      .flat()
      .find((entry) => entry.externalId === input.item.externalId)!;
    const shape = found.extractShape;
    if (shape.mode === "skip") {
      throw new ConnectorItemSkipError(shape.reason);
    }
    if (shape.mode === "file") {
      return {
        item: input.item,
        file: {
          fileName: shape.fileName,
          mimeType: shape.fileMimeType,
          sizeBytes: Buffer.byteLength(found.body),
          download: async () => Buffer.from(found.body),
        },
      };
    }
    return { item: input.item, contentText: found.body };
  });
  const discoverPages = vi.fn(async function* (input: {
    cursor?: { continuation?: Record<string, unknown> | null };
  }) {
    const start = Number(input.cursor?.continuation?.page ?? 1) - 1;
    for (let index = start; index < pagesOf.length; index += 1) {
      const complete = index === pagesOf.length - 1;
      yield {
        items: pagesOf[index]!.map(
          ({ body: _body, extractShape: _extractShape, ...rest }) => rest,
        ),
        continuation: complete ? null : { page: String(index + 2) },
        checkpoint: complete ? { history: "h1" } : null,
        complete,
        ...(complete && options.reconcile ? { reconcileMissing: true } : {}),
      };
    }
  });
  const adapter = {
    getManifest: () => ({
      type: "fake_quota",
      displayName: "Fake quota source",
      auth: {
        kind: "oauth2" as const,
        authorizationUrl: "https://example.com/auth",
        tokenUrl: "https://example.com/token",
        scopes: [],
      },
      sync: {
        supportsIncremental: true,
        defaultFrequencyMinutes: 60,
        resources: [
          {
            type: "document",
            displayName: "Document",
            supportsDeleteDetection: options.reconcile === true,
          },
        ],
      },
      actions: [],
      configSchema: { type: "object" },
    }),
    async *discover() {},
    discoverPages,
    extract,
  } as unknown as ConnectorAdapter;
  return { adapter, extract, discoverPages };
}

/**
 * Stands in for embedding + settlement: charges the fake balance like
 * `meterIngestion` would, or rejects at settlement when `raceOnce` is set.
 */
export function stubIndexing(
  ctx: ConnectorTestContext,
  billing: ReturnType<typeof fakeBilling>,
) {
  const { schema, indexing } = ctx;
  const calls: IndexCall[] = [];
  const control = { raceOnce: false };
  vi.spyOn(
    indexing.SourceIndexingService.prototype,
    "indexSourceRevision",
  ).mockImplementation(async function (input) {
    const [row] = await schema.db
      .select()
      .from(schema.sources)
      .where(eq(schema.sources.id, input.sourceId));
    const needed = Math.max(
      1,
      Math.ceil((row?.contentText.length ?? 0) / PAGE_CHARS),
    );
    calls.push({ sourceId: input.sourceId, userId: input.userId });
    if (control.raceOnce || billing.pages.available < needed) {
      control.raceOnce = false;
      await schema.db
        .update(schema.sources)
        .set({ status: "failed" })
        .where(eq(schema.sources.id, input.sourceId));
      throw new BillingError(
        "PAGES_LIMIT_EXCEEDED",
        402,
        "Ingestion pages limit exceeded",
        {
          requested: needed,
          available: billing.pages.available,
        },
      );
    }
    billing.pages.available -= needed;
    await schema.db
      .update(schema.sources)
      .set({ status: "indexed", indexedAt: new Date() })
      .where(eq(schema.sources.id, input.sourceId));
    return {} as never;
  });
  return { calls, control };
}

/** Builds a `setup()` bound to the modules a suite imported after pointing
 * DATABASE_URL at its own isolated clone. */
export function makeSetup(ctx: ConnectorTestContext) {
  const { schema, connectorRuntime, syncRunRepo } = ctx;
  return async function setup(input: {
    pagesOf: Array<TestConnectorItem[]>;
    billing?: Partial<Pages>;
    owner?: string | null;
    reconcile?: boolean;
  }) {
    const teamId = randomUUID();
    const workspaceId = randomUUID();
    const connectorId = randomUUID();
    await schema.db.insert(schema.workspaces).values({
      id: workspaceId,
      organizationId: teamId,
      name: "Quota test",
      slug: workspaceId,
    });
    await schema.db.insert(schema.sourceConnectors).values({
      id: connectorId,
      teamId,
      workspaceId,
      connectorType: "fake_quota",
      name: connectorId,
      createdBy: input.owner === undefined ? OWNER : input.owner,
    });
    const billing = fakeBilling(input.billing);
    const fake = fakeAdapter(input.pagesOf, { reconcile: input.reconcile });
    const index = stubIndexing(ctx, billing);
    const resolveActor = vi.fn(
      async (actor: { ownerUserId: string | null }) => actor.ownerUserId,
    );
    const orchestrator = new connectorRuntime.ConnectorSyncOrchestrator(
      billing.port,
      new connectorRuntime.ConnectorRegistry([fake.adapter]),
      {
        getRuntimeToken: async () => "token",
      } as unknown as InstanceType<
        typeof connectorRuntime.ConnectorOAuthService
      >,
      resolveActor,
    );
    const target = { teamId, workspaceId, connectorId };
    async function sync(
      triggerType: "manual" | "scheduled" | "webhook" = "manual",
      targetExternalIds?: string[],
    ) {
      const run = await syncRunRepo.createSyncRunRecord({
        ...target,
        triggerType,
        status: "queued",
      });
      await orchestrator.run({
        ...target,
        runId: run.id,
        userId: TRIGGER,
        ...(targetExternalIds ? { targetExternalIds } : {}),
      });
      const [row] = await schema.db
        .select()
        .from(schema.connectorSyncRuns)
        .where(eq(schema.connectorSyncRuns.id, run.id));
      return row!;
    }
    async function connectorRow() {
      const [row] = await schema.db
        .select()
        .from(schema.sourceConnectors)
        .where(eq(schema.sourceConnectors.id, connectorId));
      return row!;
    }
    async function sourceRows() {
      return schema.db
        .select()
        .from(schema.sources)
        .where(eq(schema.sources.connectorId, connectorId));
    }
    async function cursor() {
      const [row] = await schema.db
        .select()
        .from(schema.connectorSyncState)
        .where(eq(schema.connectorSyncState.connectorId, connectorId));
      return row;
    }
    return {
      ...target,
      orchestrator,
      billing,
      fake,
      index,
      resolveActor,
      sync,
      connectorRow,
      sourceRows,
      cursor,
    };
  };
}
