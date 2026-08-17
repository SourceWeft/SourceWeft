/**
 * Wiring test for the delegate run-context resolver: with the gateway + run
 * config faked (no real billing / retrieval), it rebuilds a billed model, a
 * tenant backend, and the read-only search_sources tool, and opens the billing
 * scope with the right tenancy — the invariant the sync path guards.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { createDelegateRunContextResolver } from "./run-context-resolver";
import type { RunConfig, RunRecord } from "./types";

const RUN: RunRecord = {
  runId: "run_abc",
  threadId: "thread_abc",
  graphId: "explore",
  status: "running",
  multitaskStrategy: "reject",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const CONFIG: RunConfig = {
  input: { messages: [{ role: "user", content: "investigate the auth flow" }] },
  context: {
    teamId: "team_1",
    workspaceId: "ws_1",
    userId: "user_1",
    modelAlias: "chat-default",
    providerModel: "deepseek-chat",
    profileAlias: "default",
    gatewayConfigId: "gw_1",
    parentThreadId: "thread_parent",
    sourceIds: ["src_a"],
  },
};

function deps(overrides: Record<string, unknown> = {}) {
  const calls: { openGateway?: unknown; agentChatModel?: unknown } = {};
  const fakeModel = { _fake: "model" };
  return {
    calls,
    fakeModel,
    resolver: createDelegateRunContextResolver({
      store: { getRunConfig: async () => CONFIG },
      billing: {} as never,
      resolveBillingOrganizationId: async () => "billing_team_1",
      getCheckpointer: async () => ({ _fake: "checkpointer" }),
      openGateway: (async (input: unknown) => {
        calls.openGateway = input;
        return {
          scope: {} as never,
          gateway: {
            agentChatModel: async (a: unknown) => {
              calls.agentChatModel = a;
              return fakeModel as never;
            },
          },
        };
      }) as never,
      ...overrides,
    }),
  };
}

test("resolves a billed model + backend + search_sources tool, scoped to the run", async () => {
  const { resolver, calls, fakeModel } = deps();
  const ctx = await resolver(RUN);

  assert.equal(ctx.model, fakeModel);
  assert.ok(ctx.backend, "a tenant backend is built");
  assert.deepEqual(ctx.checkpointer, { _fake: "checkpointer" });
  assert.equal(ctx.input.messages[0]?.content, "investigate the auth flow");
  assert.ok(
    ctx.availableTools.some((t) => t.name === "search_sources"),
    `expected search_sources; got ${ctx.availableTools.map((t) => t.name).join(", ")}`,
  );

  // Billing scope opened with the RESOLVED billing team, billed intent, and the
  // run id as the idempotency root (worker-job scope) — the money-critical bits.
  const gw = calls.openGateway as {
    gatewayConfigId: string;
    context: {
      teamId: string;
      workspaceId: string;
      actorUserId: string;
      intent: { mode: string };
      scopeKind: string;
      scopeId: string;
      threadId: string;
    };
  };
  assert.equal(gw.gatewayConfigId, "gw_1");
  assert.equal(gw.context.teamId, "billing_team_1");
  assert.equal(gw.context.workspaceId, "ws_1");
  assert.equal(gw.context.actorUserId, "user_1");
  assert.equal(gw.context.intent.mode, "billed");
  assert.equal(gw.context.scopeKind, "worker-job");
  assert.equal(gw.context.scopeId, "run_abc");
  assert.equal(gw.context.threadId, "thread_parent");

  // The model alias split mirrors the sync path: agentChatModel gets
  // providerModel; billing carries modelAlias/profileAlias.
  const m = calls.agentChatModel as {
    modelAlias: string;
    billing: { modelAlias: string; profileAlias: string; modelKind: string };
  };
  assert.equal(m.modelAlias, "deepseek-chat");
  assert.equal(m.billing.modelAlias, "chat-default");
  assert.equal(m.billing.profileAlias, "default");
  assert.equal(m.billing.modelKind, "chat");
});

test("throws when the run has no persisted config (cannot bill unscoped)", async () => {
  const resolver = createDelegateRunContextResolver({
    store: { getRunConfig: async () => null },
  });
  await assert.rejects(() => resolver(RUN), /No run config/);
});
