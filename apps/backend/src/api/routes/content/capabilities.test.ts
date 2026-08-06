import assert from "node:assert/strict";
import { Hono } from "hono";
import { test, vi } from "vitest";
import { ApiError, ApiResponse, toApiError } from "../../response/api-response";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  listCapabilityCatalog: vi.fn(),
  listHiddenManagedBuiltinSlugs: vi.fn(),
  requireContentWorkspace: vi.fn(),
  requireSession: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: mocks.getSessionUserId,
  requireSession: mocks.requireSession,
}));

vi.mock("../../../modules/workspace", () => ({
  requireContentWorkspace: mocks.requireContentWorkspace,
}));

vi.mock("../../../modules/threads/turn/capability-command-workflows", () => ({
  listCapabilityCatalog: mocks.listCapabilityCatalog,
}));

vi.mock("../../../modules/skills", () => ({
  contentSkillsService: {
    listHiddenManagedBuiltinSlugs: mocks.listHiddenManagedBuiltinSlugs,
  },
}));

import { registerCapabilityRoutes } from "./capabilities";

function createTestApp() {
  const app = new Hono();
  const workspaceRoutes = new Hono();
  registerCapabilityRoutes(workspaceRoutes);
  app.route("/v1/workspaces/:workspaceId", workspaceRoutes);
  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  return app;
}

function resetRouteMocks() {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockReturnValue("user_1");
  mocks.requireSession.mockResolvedValue({
    user: {
      id: "user_1",
      email: "user@example.com",
      name: "User",
    },
    session: {
      id: "session_1",
      userId: "user_1",
    },
  });
  mocks.requireContentWorkspace.mockResolvedValue({
    id: "workspace_1",
    organizationId: "team_1",
  });
  mocks.listHiddenManagedBuiltinSlugs.mockResolvedValue([]);
}

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

test("GET /capabilities/catalog includes command icon metadata", async () => {
  resetRouteMocks();
  mocks.listCapabilityCatalog.mockResolvedValue({
    commands: [
      {
        action: { kind: "skill", targetId: "ppt-deck" },
        aliases: ["ppt", "slides"],
        capabilityId: "sourceweft/ppt-deck",
        category: "Artifacts",
        contributionId: "ppt-deck",
        displayTitle: "PPT Deck",
        iconName: "presentation",
        iconTone: "mono",
        id: "cap:sourceweft/ppt-deck:ppt-deck",
        order: 0,
        parentKind: "skill",
        parentTitle: "PPT Deck",
        sourcePackageName: "@sourceweft/builtin-skill-ppt-deck",
        title: "PPT Deck",
        visible: true,
        workflow: null,
      },
    ],
    tools: [],
  });

  const response = await createTestApp().request(
    "/v1/workspaces/workspace_1/capabilities/catalog",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), {
    commands: [
      {
        action: { kind: "skill", targetId: "ppt-deck" },
        aliases: ["ppt", "slides"],
        capabilityId: "sourceweft/ppt-deck",
        category: "Artifacts",
        contributionId: "ppt-deck",
        displayTitle: "PPT Deck",
        hasWorkflow: false,
        iconName: "presentation",
        iconTone: "mono",
        id: "cap:sourceweft/ppt-deck:ppt-deck",
        order: 0,
        parentKind: "skill",
        parentTitle: "PPT Deck",
        sourcePackageName: "@sourceweft/builtin-skill-ppt-deck",
        title: "PPT Deck",
        visible: true,
      },
    ],
    tools: [],
  });
});

test("GET /capabilities/catalog hides uninstalled managed builtin skill commands", async () => {
  resetRouteMocks();
  // feynman is a managed builtin not installed in this workspace; ppt-deck is
  // an always-on builtin and must remain.
  mocks.listHiddenManagedBuiltinSlugs.mockResolvedValue(["feynman"]);
  mocks.listCapabilityCatalog.mockResolvedValue({
    commands: [
      {
        action: { kind: "skill", targetId: "feynman" },
        aliases: ["feynman"],
        capabilityId: "sourceweft/feynman",
        category: "Skills",
        contributionId: "feynman",
        displayTitle: "Feynman",
        id: "cap:sourceweft/feynman:feynman",
        order: 0,
        parentKind: "skill",
        parentTitle: "Feynman",
        sourcePackageName: "@sourceweft/builtin-skill-feynman",
        title: "Feynman",
        visible: true,
        workflow: null,
      },
      {
        action: { kind: "skill", targetId: "ppt-deck" },
        aliases: ["ppt"],
        capabilityId: "sourceweft/ppt-deck",
        category: "Artifacts",
        contributionId: "ppt-deck",
        displayTitle: "PPT Deck",
        id: "cap:sourceweft/ppt-deck:ppt-deck",
        order: 1,
        parentKind: "skill",
        parentTitle: "PPT Deck",
        sourcePackageName: "@sourceweft/builtin-skill-ppt-deck",
        title: "PPT Deck",
        visible: true,
        workflow: null,
      },
    ],
    tools: [],
  });

  const response = await createTestApp().request(
    "/v1/workspaces/workspace_1/capabilities/catalog",
  );

  assert.equal(response.status, 200);
  const body = await readJson(response);
  const commands = body.commands as Array<{
    action: { targetId: string };
  }>;
  assert.deepEqual(
    commands.map((command) => command.action.targetId),
    ["ppt-deck"],
  );
});
