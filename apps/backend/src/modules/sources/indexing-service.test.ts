import { adaptBillingTestPort } from "../../test/billing-runtime";
import { beforeEach, expect, test, vi } from "vitest";

const TEAM_ID = "team_1";
const WORKSPACE_ID = "ws_1";
const SOURCE_ID = "src_1";
const USER_ID = "user_1";

const workspace = { id: WORKSPACE_ID, organizationId: TEAM_ID };
const source = {
  id: SOURCE_ID,
  title: "Doc",
  contentText: "hello world",
  parsingConfig: {},
  estimatedPages: 1,
  parsedTokens: 10,
};

const requireContentSource = vi.fn();
const listSourceRevisionRecords = vi.fn();
const isLatestSourceRevision = vi.fn();
const updateSourceStatus = vi.fn();
const updateSourceStatusForLatestRevision = vi.fn();
const createSourceDocumentChunksAndEmbeddings = vi.fn();
const withBilledModelGateway = vi.fn();
const requireDefaultModelGatewayProfile = vi.fn();
const pinnedConfig = {
  versionId: "prepared-version",
  providers: {},
  modelRoutes: {},
};
let embedResult: {
  embeddings: number[][];
  provider: string;
  providerModel: string;
  routeDecision: null;
  usage: { totalTokens: number };
};
const identity = {
  version: 1,
  revision: "test-definition",
  profileId: "global:embedding:test",
  profileAlias: "default-embedding",
  provider: "test",
  providerKind: "openai-compatible",
  baseUrl: "http://test.internal",
  providerModel: "test-embed",
  requestedDimensions: 2,
  providerRouting: null,
};
const ensureModelConfigAvailable = vi.fn();
const recordGatewayOperationEvent = vi.fn();

vi.mock("./guards", () => ({
  requireContentSource: (...args: unknown[]) => requireContentSource(...args),
}));

vi.mock("./repository", () => ({
  listSourceRevisionRecords: (...args: unknown[]) =>
    listSourceRevisionRecords(...args),
  isLatestSourceRevision: (...args: unknown[]) =>
    isLatestSourceRevision(...args),
  updateSourceStatus: (...args: unknown[]) => updateSourceStatus(...args),
  updateSourceStatusForLatestRevision: (...args: unknown[]) =>
    updateSourceStatusForLatestRevision(...args),
  createSourceDocumentChunksAndEmbeddings: (...args: unknown[]) =>
    createSourceDocumentChunksAndEmbeddings(...args),
}));

vi.mock("../../shared/model-gateway/index", () => ({
  ensureModelConfigAvailable: (...args: unknown[]) =>
    ensureModelConfigAvailable(...args),
  requireDefaultModelGatewayProfile: (...args: unknown[]) =>
    requireDefaultModelGatewayProfile(...args),
  withBilledModelGateway: (...args: unknown[]) =>
    withBilledModelGateway(...args),
}));

vi.mock(
  "../../shared/model-gateway/embedding-identity",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../shared/model-gateway/embedding-identity")
    >()),
    prepareEmbeddingProfile: async () => ({
      profile: await requireDefaultModelGatewayProfile(),
      routedConfig: pinnedConfig,
      identity,
    }),
  }),
);

vi.mock("../content/model-gateway-audit", () => ({
  recordGatewayOperationEvent: (...args: unknown[]) =>
    recordGatewayOperationEvent(...args),
}));

const { SourceIndexingService } = await import("./indexing-service");

/** Captures what the call site handed the billing wrapper. */
type Captured = {
  scopeInput?: Record<string, any>;
  embedOptions?: Record<string, any>;
  embedPayload?: unknown;
};

let captured: Captured;
let billing: {
  meterIngestion: ReturnType<typeof vi.fn>;
  getSummary: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  captured = {};
  embedResult = {
    embeddings: [[0.1, 0.2]],
    provider: "test",
    providerModel: "test-embed",
    routeDecision: null,
    usage: { totalTokens: 5 },
  };

  requireContentSource.mockResolvedValue({ workspace, source });
  listSourceRevisionRecords.mockResolvedValue([]);
  isLatestSourceRevision.mockResolvedValue(true);
  updateSourceStatus.mockResolvedValue(source);
  updateSourceStatusForLatestRevision.mockResolvedValue(source);
  createSourceDocumentChunksAndEmbeddings.mockResolvedValue({ source });
  ensureModelConfigAvailable.mockResolvedValue(undefined);
  recordGatewayOperationEvent.mockResolvedValue(undefined);

  requireDefaultModelGatewayProfile.mockResolvedValue({
    id: "global:embedding:test",
    gatewayConfigId: "gw_1",
    profileAlias: "default-embedding",
    modelAlias: "test-embed",
    vectorStrategy: "exact",
    requestedDimensions: 2,
    annIndexName: null,
  });

  withBilledModelGateway.mockImplementation(
    async (input: Record<string, any>, run: (gateway: any) => Promise<any>) => {
      captured.scopeInput = input;
      return run({
        embeddings: {
          embedBatch: async (payload: unknown, options: any) => {
            captured.embedOptions = options;
            captured.embedPayload = payload;
            return embedResult;
          },
        },
      });
    },
  );

  billing = adaptBillingTestPort({
    meterIngestion: vi.fn().mockResolvedValue({ ok: true }),
    getSummary: vi.fn(),
  });
});

function makeService() {
  return new SourceIndexingService(billing as any);
}

const chunks = [{ text: "hello world", startIndex: 0, endIndex: 11 }] as any;

test("embedBatch runs through the billed wrapper as a covered ingestion call", async () => {
  await makeService().indexSource({
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    userId: USER_ID,
    chunks,
  });

  expect(withBilledModelGateway).toHaveBeenCalledTimes(1);
  expect(captured.scopeInput?.billing).toBe(billing);
  expect(captured.scopeInput?.gatewayConfigId).toBe("gw_1");
  expect(captured.scopeInput?.routedConfig).toBe(pinnedConfig);
  expect(captured.embedPayload).toMatchObject({
    model: "default-embedding",
    profileAlias: "default-embedding",
  });
  expect(createSourceDocumentChunksAndEmbeddings).toHaveBeenCalledWith(
    expect.objectContaining({ embeddingIdentity: identity }),
  );
  expect(captured.scopeInput?.context).toMatchObject({
    teamId: TEAM_ID,
    workspaceId: WORKSPACE_ID,
    actorUserId: USER_ID,
    feature: "ingestion",
    scopeKind: "worker-job",
    intent: { mode: "covered", coveredBy: "model_kind_not_user_billed" },
  });
});

test("embedBatch pins the pre-migration idempotency key", async () => {
  await makeService().indexSource({
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    userId: USER_ID,
    chunks,
  });

  expect(captured.embedOptions).toMatchObject({
    operation: "embeddings.embedBatch",
    modelKind: "embedding",
    gatewayConfigId: "gw_1",
    profileAlias: "default-embedding",
    modelAlias: "test-embed",
    idempotencyKey: `source-index:${SOURCE_ID}:embeddings`,
    traceId: SOURCE_ID,
  });
});

test("an explicit idempotency key still wins for both embeddings and page billing", async () => {
  await makeService().indexSource({
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    userId: USER_ID,
    idempotencyKey: "custom-key",
    chunks,
  });

  expect(captured.embedOptions?.idempotencyKey).toBe("custom-key");
  expect(billing.meterIngestion).toHaveBeenCalledWith(
    TEAM_ID,
    expect.objectContaining({ idempotencyKey: "custom-key" }),
    USER_ID,
  );
});

test("trusted PDF page-based ingestion billing is unchanged by the migration", async () => {
  requireContentSource.mockResolvedValue({
    workspace,
    source: {
      ...source,
      mimeType: "application/pdf",
      metadata: { pageCount: 3, pageCountSource: "pdfjs" },
    },
  });
  await makeService().indexSource({
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    userId: USER_ID,
    parsedPages: 3,
    chunks,
  });

  expect(billing.meterIngestion).toHaveBeenCalledTimes(1);
  expect(billing.meterIngestion).toHaveBeenCalledWith(
    TEAM_ID,
    {
      workspaceId: WORKSPACE_ID,
      feature: "ingestion",
      referenceId: `source:${SOURCE_ID}`,
      idempotencyKey: `source-index:${SOURCE_ID}`,
      pages: 3,
      parsedTokens: 3,
    },
    USER_ID,
  );
});

test("no embedding call is made when the profile disables vectors", async () => {
  requireDefaultModelGatewayProfile.mockResolvedValue({
    id: "global:embedding:test",
    gatewayConfigId: "gw_1",
    profileAlias: "default-embedding",
    modelAlias: "test-embed",
    vectorStrategy: "disabled",
    requestedDimensions: null,
    annIndexName: null,
  });

  await makeService().indexSource({
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    userId: USER_ID,
    chunks,
  });

  expect(withBilledModelGateway).not.toHaveBeenCalled();
  expect(billing.meterIngestion).toHaveBeenCalledTimes(1);
});

test("a result from a different actual model cannot write vectors or bill ingestion", async () => {
  embedResult.providerModel = "different-model";
  await expect(
    makeService().indexSource({
      workspaceId: WORKSPACE_ID,
      sourceId: SOURCE_ID,
      userId: USER_ID,
      chunks,
    }),
  ).rejects.toThrow(/different Provider or model/);
  expect(createSourceDocumentChunksAndEmbeddings).not.toHaveBeenCalled();
  expect(billing.meterIngestion).not.toHaveBeenCalled();
  expect(recordGatewayOperationEvent).toHaveBeenCalledWith(
    expect.objectContaining({ success: false }),
  );
});

for (const kind of ["manual", "docx", "csv", "epub"]) {
  test(`${kind} reindex bills body tokens rather than stale estimates or logical page one`, async () => {
    const mimeType = (
      {
        manual: "text/plain",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        csv: "text/csv",
        epub: "application/epub+zip",
      } as const
    )[kind as "manual" | "docx" | "csv" | "epub"];
    requireContentSource.mockResolvedValue({
      workspace,
      source: {
        ...source,
        mimeType,
        contentText: "x".repeat(12001),
        estimatedPages: 99,
        parsedTokens: 1,
        metadata: {
          pageCount: 1,
          parsedPages: 15,
          totalPages: 15,
          billingPageCount: 1,
          billingPageCountSource: "csv-records",
        },
      },
    });
    await makeService().indexSource({
      workspaceId: WORKSPACE_ID,
      sourceId: SOURCE_ID,
      userId: USER_ID,
      chunks,
      parsedPages: 1,
      estimatedPages: 88,
      parsedTokens: 1,
      idempotencyKey: "same-revision",
    });
    expect(billing.meterIngestion).toHaveBeenCalledWith(
      TEAM_ID,
      expect.objectContaining({
        pages: 4,
        parsedTokens: 3001,
        idempotencyKey: "same-revision",
      }),
      USER_ID,
    );
    expect(updateSourceStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        estimatedPages: 4,
        parsedTokens: 3001,
        metadata: expect.objectContaining({
          ingestionBillingBasis: "text-equivalent",
          ingestionBillingPages: 4,
          parsedPages: 0,
          totalPages: 0,
        }),
      }),
    );
    const writtenMetadata = updateSourceStatus.mock.calls[0]?.[0].metadata;
    for (const key of [
      "billingPageCount",
      "billingPageCountSource",
      "pageCount",
    ])
      expect(writtenMetadata).not.toHaveProperty(key);
  });
}

test("PDF reindex uses trusted physical pages even when text is longer", async () => {
  requireContentSource.mockResolvedValue({
    workspace,
    source: {
      ...source,
      mimeType: "application/pdf",
      contentText: "x".repeat(40001),
      metadata: { pageCount: 2, pageCountSource: "pdfjs" },
      estimatedPages: 77,
    },
  });
  await makeService().indexSource({
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    userId: USER_ID,
    chunks,
    estimatedPages: 99,
  });
  expect(billing.meterIngestion).toHaveBeenCalledWith(
    TEAM_ID,
    expect.objectContaining({ pages: 2, parsedTokens: 10001 }),
    USER_ID,
  );
});

test("empty source cannot become a one-page charge through stale estimates or chunks", async () => {
  requireContentSource.mockResolvedValue({
    workspace,
    source: {
      ...source,
      contentText: " ",
      parsedTokens: 1000,
      estimatedPages: 5,
    },
  });
  await expect(
    makeService().indexSource({
      workspaceId: WORKSPACE_ID,
      sourceId: SOURCE_ID,
      userId: USER_ID,
      chunks,
      parsedTokens: 1000,
    }),
  ).rejects.toThrow(/Nonempty source content/);
  expect(billing.meterIngestion).not.toHaveBeenCalled();
});
