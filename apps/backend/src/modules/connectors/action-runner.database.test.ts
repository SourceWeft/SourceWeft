import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import type { ConnectorAccessPolicy } from "./access-policy";
import type {
  ConnectorActionInput,
  ConnectorActionSpec,
  ConnectorAdapter,
} from "./types";

let schema: typeof import("@sourceweft/db");
let runnerModule: typeof import("./action-runner");
let accessModule: typeof import("./access-policy");
let registryModule: typeof import("./registry");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("connector_action");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  runnerModule = await import("./action-runner");
  accessModule = await import("./access-policy");
  registryModule = await import("./registry");
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/** Resolves every caller only once `parties` of them have arrived. */
function barrier(parties: number) {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) open();
    await gate;
  };
}

/**
 * A connector with one approval-gated action whose provider call is counted.
 * Inline rather than the real capability: the host must not import one.
 */
function actionAdapter(connectorType: string, action: ConnectorActionSpec) {
  const executeAction = vi.fn(async (_input: ConnectorActionInput) => ({
    externalId: `external_${executeAction.mock.calls.length}`,
    result: { done: true },
  }));
  const adapter = {
    getManifest: () => ({
      type: connectorType,
      displayName: connectorType,
      auth: {
        kind: "oauth2" as const,
        authorizationUrl: "https://example.com/auth",
        tokenUrl: "https://example.com/token",
        scopes: [],
      },
      sync: {
        supportsIncremental: false,
        defaultFrequencyMinutes: 60,
        resources: [],
      },
      actions: [action],
      configSchema: { type: "object" },
    }),
    async *discover() {},
    executeAction,
  } as unknown as ConnectorAdapter;
  return { adapter, executeAction };
}

async function setup(input: {
  adapter: ConnectorAdapter;
  connectorType: string;
  scopes?: string[];
}) {
  const teamId = randomUUID();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const connectorId = randomUUID();
  await schema.database.query(
    'insert into organization (id, name, slug, "createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await schema.database.query(
    'insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1,$1,$2,true,now(),now())',
    [userId, `${userId}@example.test`],
  );
  await schema.database.query(
    `insert into member (id, "organizationId", "userId", role, "createdAt")
     values ($1,$2,$3,'owner',now())`,
    [randomUUID(), teamId, userId],
  );
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Connector action test",
    slug: workspaceId,
    isDefault: true,
  });
  let oauthAccountId: string | null = null;
  if (input.scopes) {
    oauthAccountId = randomUUID();
    await schema.db.insert(schema.connectorOAuthAccounts).values({
      id: oauthAccountId,
      teamId,
      workspaceId,
      connectorType: input.connectorType,
      displayName: "sender@example.com",
      scopes: input.scopes,
      accessTokenEncrypted: "unused-by-the-fake-oauth-service",
    });
  }
  await schema.db.insert(schema.sourceConnectors).values({
    id: connectorId,
    teamId,
    workspaceId,
    connectorType: input.connectorType,
    name: connectorId,
    oauthAccountId,
    createdBy: userId,
  });

  const registry = new registryModule.ConnectorRegistry([input.adapter]);
  const oauthService = { getRuntimeToken: async () => "runtime-token" };
  const preview = { isEnabled: async () => true };
  const runner = new runnerModule.ConnectorActionRunner(
    registry,
    oauthService as never,
    new accessModule.ConnectorAccessPolicy(preview as never, registry),
  );

  /**
   * Two runners (as if two API processes took duplicate resume requests)
   * that each pause after reading the approved action and before claiming
   * it, so both executions are inside the check-then-act window at once.
   */
  function racingRunners() {
    const bothRead = barrier(2);
    class HoldingAccessPolicy extends accessModule.ConnectorAccessPolicy {
      override async requireConnection(
        ...args: Parameters<ConnectorAccessPolicy["requireConnection"]>
      ) {
        await super.requireConnection(...args);
        await bothRead();
      }
    }
    return [1, 2].map(
      () =>
        new runnerModule.ConnectorActionRunner(
          registry,
          oauthService as never,
          new HoldingAccessPolicy(preview as never, registry),
        ),
    );
  }

  async function actionRow(actionRunId: string) {
    const [row] = await schema.db
      .select()
      .from(schema.connectorActionRuns)
      .where(eq(schema.connectorActionRuns.id, actionRunId));
    return row!;
  }

  return {
    teamId,
    workspaceId,
    userId,
    connectorId,
    runner,
    racingRunners,
    actionRow,
  };
}

test("concurrent executions of one approved Gmail send call Gmail exactly once", async () => {
  const gmail = actionAdapter("gmail", {
    type: "gmail.message.send",
    displayName: "Send Gmail message",
    riskLevel: "high",
    requiresApproval: true,
    requestPrivacy: "encrypted",
    allowStandingApproval: false,
    agentToolName: "send_gmail_message",
    visibility: "agent",
    inputSchema: {
      type: "object",
      required: ["to", "subject", "body"],
      additionalProperties: false,
      properties: {
        to: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
      },
    },
  });
  const t = await setup({
    adapter: gmail.adapter,
    connectorType: "gmail",
    scopes: [GMAIL_SEND_SCOPE],
  });
  const request = {
    to: ["recipient@example.com"],
    subject: "Quarterly numbers",
    body: "Send me once.",
  };
  const target = {
    workspaceId: t.workspaceId,
    connectorId: t.connectorId,
    userId: t.userId,
  };
  const { action: proposed } = await t.runner.propose({
    ...target,
    actionType: "gmail.message.send",
    requestJson: request,
  });
  await t.runner.approve({ ...target, actionRunId: proposed.id });

  const results = await Promise.all(
    t.racingRunners().map((runner) =>
      runner.execute({
        ...target,
        actionRunId: proposed.id,
        expected: {
          actionType: "gmail.message.send",
          agentToolName: "send_gmail_message",
          requestJson: request,
        },
      }),
    ),
  );

  assert.equal(gmail.executeAction.mock.calls.length, 1);
  // The winner sent the decrypted, approved message, not the stored ciphertext.
  assert.deepEqual(gmail.executeAction.mock.calls[0]?.[0]?.request, request);
  assert.deepEqual(
    results.map((result) => result.action.id),
    [proposed.id, proposed.id],
  );
  const statuses = results.map((result) => result.action.status).sort();
  assert.ok(
    statuses[0] === "running" || statuses[0] === "succeeded",
    `the losing execution reports the claimed record, got ${statuses[0]}`,
  );
  assert.equal(statuses[1], "succeeded");
  const row = await t.actionRow(proposed.id);
  assert.equal(row.status, "succeeded");
  assert.equal(row.externalId, "external_1");
  assert.equal(row.executedBy, t.userId);
});

test("the claim guards every connector action type, not only Gmail", async () => {
  const fake = actionAdapter("fake_action", {
    type: "fake_action.item.create",
    displayName: "Create item",
    riskLevel: "medium",
    requiresApproval: true,
    agentToolName: "create_fake_item",
    visibility: "agent",
    inputSchema: {
      type: "object",
      required: ["title"],
      additionalProperties: false,
      properties: { title: { type: "string" } },
    },
  });
  const t = await setup({
    adapter: fake.adapter,
    connectorType: "fake_action",
  });
  const target = {
    workspaceId: t.workspaceId,
    connectorId: t.connectorId,
    userId: t.userId,
  };
  const { action: proposed } = await t.runner.propose({
    ...target,
    actionType: "fake_action.item.create",
    requestJson: { title: "Once" },
  });
  await t.runner.approve({ ...target, actionRunId: proposed.id });

  await Promise.all(
    t
      .racingRunners()
      .map((runner) => runner.execute({ ...target, actionRunId: proposed.id })),
  );

  assert.equal(fake.executeAction.mock.calls.length, 1);
  assert.equal((await t.actionRow(proposed.id)).status, "succeeded");
});
