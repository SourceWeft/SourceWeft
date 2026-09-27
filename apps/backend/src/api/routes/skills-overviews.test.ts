import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createRouteTestApp } from "../../test/hono";
import { ApiError } from "../response/api-response";

// The overview admin routes: who may call them, what each passes down, and
// the shapes that come back. The market functions are mocked; their SQL is
// covered by the database suite.
const mocks = vi.hoisted(() => ({
  admin: true,
  regenerateSkillOverview: vi.fn(),
  setSkillOverviewVisibility: vi.fn(),
  getSkillOverviewStatus: vi.fn(),
  findSkillOverviewAdminState: vi.fn(),
}));

vi.mock("./skills-market-admin", () => ({
  requireSkillMarketAdmin: async () => {
    if (!mocks.admin)
      throw ApiError.forbidden("Registry admin access required");
    return { user: { id: "admin_1" } };
  },
}));

vi.mock("../middleware/auth-session", async () =>
  (await import("../../test/hono")).signedInAs("admin_1"),
);
vi.mock("../../modules/market/admin", () => ({
  isMarketAdmin: () => mocks.admin,
}));
vi.mock("../../modules/skills/market/auto-list", () => ({
  acknowledgeSkillVersion: vi.fn(),
}));
vi.mock("../../modules/skills/market/overview-admin", () => ({
  regenerateSkillOverview: mocks.regenerateSkillOverview,
  setSkillOverviewVisibility: mocks.setSkillOverviewVisibility,
  getSkillOverviewStatus: mocks.getSkillOverviewStatus,
}));
vi.mock("../../modules/skills/market/overview-repository", () => ({
  findSkillOverviewAdminState: mocks.findSkillOverviewAdminState,
}));

vi.mock("../../modules/skills/market/analysis-admin", () => ({
  previewSkillAnalysis: vi.fn(),
  enqueueSkillAnalysisBatch: vi.fn(),
}));

import { registerSkillOverviewRoutes } from "./skills-overviews";

const createTestApp = () => createRouteTestApp(registerSkillOverviewRoutes);

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const admin = "/v1/skills/registry/admin";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin = true;
});

test("every overview admin route refuses someone who is not a market admin", async () => {
  mocks.admin = false;
  const app = createTestApp();
  for (const [path, init] of [
    [`${admin}/overviews/status`, undefined],
    [`${admin}/overviews/preview`, undefined],
    [`${admin}/overviews/batch`, json("POST", { skillVersionIds: ["v1"] })],
    [`${admin}/skills/skill_1/overview`, undefined],
    [`${admin}/skills/skill_1/overview/regenerate`, { method: "POST" }],
    [
      `${admin}/skills/skill_1/overview/visibility`,
      json("POST", { hidden: true }),
    ],
  ] as const) {
    const response = await app.request(path, init);
    assert.equal(response.status, 403, path);
  }
  assert.equal(mocks.regenerateSkillOverview.mock.calls.length, 0);
});

test("the overview billing setting is gone", async () => {
  const app = createTestApp();
  for (const init of [
    undefined,
    json("PUT", { teamId: "team_1", workspaceId: "ws_1" }),
  ]) {
    const response = await app.request(
      `${admin}/settings/overview-billing`,
      init,
    );
    assert.equal(response.status, 404);
  }
});

test("one skill's overview comes back with every locale", async () => {
  mocks.findSkillOverviewAdminState.mockResolvedValue({
    skillId: "skill_1",
    skillVersionId: "ver_1",
    bundleSha256: "sha",
    eligible: true,
    overviews: [
      {
        locale: "en",
        overview: {
          summary: "s",
          whatItDoes: "w",
          whenToUse: "u",
          requirements: "",
          suggestedCategories: [],
        },
        model: "m",
        hidden: false,
        generatedAt: new Date("2026-09-22T01:00:00.000Z"),
      },
    ],
  });
  const app = createTestApp();
  const response = await app.request(`${admin}/skills/skill_1/overview`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    overviews: Array<{ generatedAt: string }>;
  };
  assert.equal(body.overviews[0]?.generatedAt, "2026-09-22T01:00:00.000Z");

  mocks.findSkillOverviewAdminState.mockResolvedValue(null);
  assert.equal(
    (await app.request(`${admin}/skills/nope/overview`)).status,
    404,
  );
});

test("regenerate and visibility pass the acting admin down", async () => {
  mocks.regenerateSkillOverview.mockResolvedValue({
    skillId: "skill_1",
    skillVersionId: "ver_1",
    deleted: 3,
    queued: true,
  });
  mocks.setSkillOverviewVisibility.mockResolvedValue({
    skillId: "skill_1",
    skillVersionId: "ver_1",
    hidden: true,
    updated: 3,
  });
  const app = createTestApp();
  const regenerated = await app.request(
    `${admin}/skills/skill_1/overview/regenerate`,
    { method: "POST" },
  );
  assert.equal(regenerated.status, 200);
  assert.deepEqual(mocks.regenerateSkillOverview.mock.calls[0]?.[0], {
    skillId: "skill_1",
    actorUserId: "admin_1",
  });

  const hidden = await app.request(
    `${admin}/skills/skill_1/overview/visibility`,
    json("POST", { hidden: true }),
  );
  assert.equal(hidden.status, 200);
  assert.deepEqual(mocks.setSkillOverviewVisibility.mock.calls[0]?.[0], {
    skillId: "skill_1",
    hidden: true,
    actorUserId: "admin_1",
  });

  assert.equal(
    (
      await app.request(
        `${admin}/skills/skill_1/overview/visibility`,
        json("POST", { hidden: "yes" }),
      )
    ).status,
    400,
  );
  mocks.regenerateSkillOverview.mockResolvedValue(null);
  assert.equal(
    (
      await app.request(`${admin}/skills/nope/overview/regenerate`, {
        method: "POST",
      })
    ).status,
    404,
  );
});

test("status reports coverage and why the system model is not ready", async () => {
  const systemModel = {
    enabled: true,
    configured: false,
    ready: false,
    provider: "openrouter",
    model: "deepseek/deepseek-v4.1-flash",
    problems: ["api_key_unset"],
    reason: "SYSTEM_MODEL_API_KEY is not set",
  };
  mocks.getSkillOverviewStatus.mockResolvedValue({
    systemModel,
    eligible: 10,
    withOverview: 7,
    missing: 3,
    hidden: 1,
  });
  const app = createTestApp();
  const response = await app.request(`${admin}/overviews/status`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    missing: number;
    systemModel: unknown;
  };
  assert.equal(body.missing, 3);
  assert.deepEqual(body.systemModel, systemModel);
});
