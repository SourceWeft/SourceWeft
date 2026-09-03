import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

// Records every table written inside the transaction so the test can assert
// that installing a skill also grants the workspace access to it.
const dbState = vi.hoisted(() => ({
  entitlementRows: [] as unknown[],
  inserts: [] as string[],
  existingEntitlement: [] as unknown[],
}));

vi.mock("@sourceweft/db", async () => {
  const actual =
    await vi.importActual<typeof import("@sourceweft/db")>("@sourceweft/db");

  function tableNameOf(table: unknown): string {
    for (const symbol of Object.getOwnPropertySymbols(table as object)) {
      if (String(symbol).includes("Name")) {
        const value = (table as Record<symbol, unknown>)[symbol];
        if (typeof value === "string") {
          return value;
        }
      }
    }
    return "unknown";
  }

  function makeTx() {
    return {
      insert(t: unknown) {
        const table = tableNameOf(t);
        return {
          values: async (rows: unknown) => {
            dbState.inserts.push(table);
            if (table === "skill_entitlements") {
              dbState.entitlementRows.push(rows);
            }
            return { returning: async () => [] };
          },
          returning: async () => [{ id: "ws-1", enabled: true }],
        };
      },
      select() {
        let table = "";
        const builder: Record<string, unknown> = {
          from(t: unknown) {
            table = tableNameOf(t);
            return builder;
          },
          where: () => builder,
          limit: async () =>
            table === "skill_entitlements" ? dbState.existingEntitlement : [],
        };
        return builder;
      },
    };
  }

  return {
    ...actual,
    db: {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(makeTx()),
    },
  };
});

const { upsertWorkspaceSkill } = await import("./repository");

beforeEach(() => {
  dbState.entitlementRows = [];
  dbState.inserts = [];
  dbState.existingEntitlement = [];
});

function install() {
  return upsertWorkspaceSkill({
    enabledBy: "user-1",
    skillId: "skill-1",
    skillVersionId: "ver-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
  }).catch(() => null);
}

// Registry skills start `restricted`, and visibleSkillCondition treats a
// restricted definition as invisible without an entitlement. Without this grant
// an install produced a workspace_skills row no runtime query could see: the
// skill never mounted and never reached the model.
test("installing a skill grants the workspace access to it", async () => {
  await install();
  assert.ok(dbState.inserts.includes("skill_entitlements"));
  assert.deepEqual(dbState.entitlementRows.length, 1);
  const row = dbState.entitlementRows[0] as Record<string, unknown>;
  assert.equal(row.skillId, "skill-1");
  assert.equal(row.teamId, "team-1");
  assert.equal(row.workspaceId, "workspace-1");
  assert.equal(row.grantedBy, "user-1");
});

test("re-installing does not stack duplicate grants", async () => {
  dbState.existingEntitlement = [{ id: "ent-1" }];
  await install();
  assert.equal(dbState.inserts.includes("skill_entitlements"), false);
});
