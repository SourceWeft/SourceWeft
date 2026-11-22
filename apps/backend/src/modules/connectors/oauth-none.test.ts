import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  requireAvailable: vi.fn(),
  createState: vi.fn(),
}));

vi.mock("../preview", () => ({
  previewAccessService: { isEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock("./permissions", () => ({
  requireConnectorWorkspace: mocks.workspace,
}));
vi.mock("../../shared/config", () => ({
  config: { auth: { baseUrl: "https://api.sourceweft.test" } },
}));
vi.mock("../../shared/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../shared/team-secrets", () => ({
  encryptTeamSecret: vi.fn(),
  decryptTeamSecret: vi.fn(),
}));
vi.mock("./repository", () => ({
  createOAuthStateRecord: mocks.createState,
}));

import { ConnectorOAuthService } from "./oauth-service";
import { ConnectorRegistry } from "./registry";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

const noneManifest: ConnectorManifest = {
  type: "public-feed",
  displayName: "Public feed",
  auth: { kind: "none" },
  sync: {
    supportsIncremental: true,
    defaultFrequencyMinutes: 360,
    resources: [],
  },
  actions: [],
  configSchema: { type: "object" },
};

const noneAdapter: ConnectorAdapter = {
  getManifest: () => noneManifest,
  async *discover() {},
  extract: async ({ item }) => ({ item, contentText: "" }),
  executeAction: async () => ({ result: {} }),
};

const service = new ConnectorOAuthService(
  new ConnectorRegistry([noneAdapter]),
  { requireAvailable: mocks.requireAvailable } as never,
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.requireAvailable.mockResolvedValue(undefined);
});

describe("start for a none connector", () => {
  it("rejects with CONNECTOR_AUTH_KIND_UNSUPPORTED and stores no state", async () => {
    await expect(
      service.start({
        workspaceId: "workspace",
        userId: "user",
        connectorType: "public-feed",
      }),
    ).rejects.toMatchObject({
      statusCode: 500,
      code: "CONNECTOR_AUTH_KIND_UNSUPPORTED",
    });
    expect(mocks.createState).not.toHaveBeenCalled();
  });
});
