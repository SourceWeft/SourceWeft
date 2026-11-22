import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolGroundedArtifactServices } from "@sourceweft/contracts/agent-tools";
import {
  bindGroundedArtifactTool,
  requestGroundedArtifactFromTurn,
} from "../src/agent-tool";

function service(sourceIds: readonly string[]) {
  const calls: Parameters<AgentToolGroundedArtifactServices["requestGeneration"]>[0][] = [];
  const grounded: AgentToolGroundedArtifactServices = {
    listTurnSourceIds: async () => sourceIds,
    requestGeneration: async (input) => {
      calls.push(input);
      return { artifactId: "a-1", versionNo: 1, status: "pending", reused: false };
    },
  };
  return { grounded, calls };
}

const LIMITS = { maxSources: 50, tooManySourcesMessage: () => "narrow the selection" };

const context = {
  threadId: "thread-1",
  isToolDenied: () => false,
  shouldBindAgentTool: (name: string) => name === "make_thing",
};

test("a grounded tool binds only when listed, selected, undenied and served", () => {
  const { grounded } = service(["s1"]);
  const services = { groundedArtifacts: grounded };
  assert.deepEqual(bindGroundedArtifactTool({ context, services }, "make_thing"), {
    threadId: "thread-1",
    grounded,
  });
  assert.equal(bindGroundedArtifactTool({ context, services }, "other_tool"), null);
  assert.equal(
    bindGroundedArtifactTool({ toolIds: ["other_tool"], context, services }, "make_thing"),
    null,
  );
  assert.equal(
    bindGroundedArtifactTool(
      { context: { ...context, isToolDenied: () => true }, services },
      "make_thing",
    ),
    null,
  );
  assert.equal(bindGroundedArtifactTool({ context, services: {} }, "make_thing"), null);
  assert.equal(
    bindGroundedArtifactTool({ context: { ...context, threadId: "" }, services }, "make_thing"),
    null,
  );
});

test("the request carries the turn's sources, never the thread or a visibility", async () => {
  const { grounded, calls } = service(["s1", "s2"]);
  const outcome = await requestGroundedArtifactFromTurn({
    binding: { threadId: "thread-1", grounded },
    artifactType: "thing",
    subject: "thing",
    parse: (request) => ({
      success: true as const,
      data: { ...request, visibility: "workspace", extra: 1 },
    }),
    uiLocale: "en",
    noSourcesMessage: "pick sources",
    ...LIMITS,
  });
  assert.deepEqual(calls, [
    { artifactType: "thing", request: { sourceIds: ["s1", "s2"], extra: 1 }, uiLocale: "en" },
  ]);
  assert.equal(outcome.ok, true);
});

test("no sources: nothing is parsed or requested, and the agent is told to ask", async () => {
  const { grounded, calls } = service([]);
  let parsed = 0;
  const outcome = await requestGroundedArtifactFromTurn({
    binding: { threadId: "thread-1", grounded },
    artifactType: "thing",
    subject: "thing",
    parse: (request) => {
      parsed += 1;
      return { success: true as const, data: request };
    },
    uiLocale: "en",
    noSourcesMessage: "pick sources",
    ...LIMITS,
  });
  assert.deepEqual(outcome, { ok: false, code: "NO_SOURCES", message: "pick sources" });
  assert.equal(parsed, 0);
  assert.deepEqual(calls, []);
});

test("an invalid request throws with each issue named and requests nothing", async () => {
  const { grounded, calls } = service(["s1"]);
  await assert.rejects(
    requestGroundedArtifactFromTurn({
      binding: { threadId: "thread-1", grounded },
      artifactType: "thing",
      subject: "thing",
      parse: () => ({
        success: false as const,
        error: { issues: [{ path: ["options", "count"], message: "too many" }] },
      }),
      uiLocale: "en",
      noSourcesMessage: "pick sources",
      ...LIMITS,
    }),
    /The thing request is not valid: options\.count: too many/,
  );
  assert.deepEqual(calls, []);
});

test("more sources than the limit: nothing is parsed or requested, and the agent is told the limit", async () => {
  const { grounded, calls } = service(["s1", "s2", "s3"]);
  let parsed = 0;
  const outcome = await requestGroundedArtifactFromTurn({
    binding: { threadId: "thread-1", grounded },
    artifactType: "thing",
    subject: "thing",
    parse: (request) => {
      parsed += 1;
      return { success: true as const, data: request };
    },
    uiLocale: "en",
    noSourcesMessage: "pick sources",
    maxSources: 2,
    tooManySourcesMessage: ({ sources, maxSources }) => `narrow ${sources} to ${maxSources}`,
  });
  assert.deepEqual(outcome, {
    ok: false,
    code: "TOO_MANY_SOURCES",
    message: "narrow 3 to 2",
    sources: 3,
    maxSources: 2,
  });
  assert.equal(parsed, 0);
  assert.deepEqual(calls, []);
});

test("exactly the limit is still requested", async () => {
  const { grounded, calls } = service(["s1", "s2"]);
  const outcome = await requestGroundedArtifactFromTurn({
    binding: { threadId: "thread-1", grounded },
    artifactType: "thing",
    subject: "thing",
    parse: (request) => ({ success: true as const, data: request }),
    uiLocale: "en",
    noSourcesMessage: "pick sources",
    maxSources: 2,
    tooManySourcesMessage: () => "narrow",
  });
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
});
