import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  list: vi.fn(),
  find: vi.fn(),
  workspace: vi.fn(),
  token: vi.fn(),
  execute: vi.fn(),
  manifests: vi.fn(),
}));
vi.mock("../preview", () => ({
  previewAccessService: { isEnabled: mocks.enabled },
}));
vi.mock("./permissions", () => ({
  requireConnectorWorkspace: mocks.workspace,
}));
vi.mock("./repository", () => ({
  listSourceConnectorRecords: mocks.list,
  findSourceConnectorRecord: mocks.find,
  findOAuthAccountRecord: vi.fn(),
}));
vi.mock("./registry", () => ({
  connectorRegistry: {
    listManifests: mocks.manifests,
    getManifest: () => ({}),
    getAdapter: () => ({ executeAction: mocks.execute }),
  },
}));
vi.mock(".", async () => ({
  connectorRegistry: (await import("./registry")).connectorRegistry,
  connectorOAuthService: { getRuntimeToken: mocks.token },
  connectorActionRunner: {},
}));
import { createConnectorActionTools } from "./agent-tools";
const context = { teamId: "team", workspaceId: "workspace", userId: "actor" };
beforeEach(() => {
  vi.clearAllMocks();
  const connection = {
    id: "connection",
    connectorType: "gmail",
    status: "active",
    createdBy: "other",
    configJson: {},
  };
  mocks.list.mockResolvedValue([connection]);
  mocks.find.mockResolvedValue(connection);
  mocks.enabled.mockResolvedValue(true);
  mocks.workspace.mockResolvedValue({ workspace: {} });
  mocks.manifests.mockReturnValue([
    {
      type: "gmail",
      displayName: "Gmail",
      actions: [
        {
          type: "gmail.message.search",
          agentToolName: "search_gmail",
          visibility: "agent",
          capabilities: ["connector_read"],
          requiresApproval: false,
          inputSchema: { type: "object", properties: {} },
        },
      ],
    },
  ]);
});
it("does not expose Gmail tools to a user without preview", async () => {
  mocks.enabled.mockResolvedValue(false);
  expect(await createConnectorActionTools(context)).toEqual([]);
});
it("rechecks current preview when a previously discovered read tool is invoked", async () => {
  const tools = await createConnectorActionTools(context);
  expect(tools).toHaveLength(1);
  mocks.enabled.mockResolvedValue(false);
  const readTool: {
    invoke(input: Record<string, unknown>): Promise<unknown>;
  } = tools[0]!;
  const result = await readTool.invoke({});
  expect(result).toMatchObject({
    code: "CONNECTOR_PREVIEW_ACCESS_DENIED",
    statusCode: 403,
  });
  expect(mocks.token).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
});
