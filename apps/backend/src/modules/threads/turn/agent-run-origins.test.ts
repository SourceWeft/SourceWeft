import assert from "node:assert/strict";
import { test } from "vitest";
import type { MessageRecord } from "../../content/types";
import {
  appendAgentRunOrigin,
  collectRefreshAgentRunOrigins,
  readAgentRunOrigins,
  MAX_AGENT_REFRESH_GRAPH_ORIGINS,
} from "./agent-run-origins";
function message(
  id: string,
  role: MessageRecord["role"] = "user",
  metadata: Record<string, unknown> = {},
): MessageRecord {
  return {
    id,
    role,
    metadata,
    teamId: "team",
    workspaceId: "workspace",
    threadId: "thread",
    parentMessageId: null,
    content: "text",
    contentJson: {},
    createdBy: "owner",
    model: null,
    creditsConsumed: null,
    createdAt: "2026-10-17T00:00:00Z",
  };
}
const scope = { teamId: "team", workspaceId: "workspace", threadId: "thread" };
test("locked origin projection appends uniquely and preserves the current metadata", () => {
  const current = message("u", "user", {
    marker: "latest",
    agentRunThreadIds: ["original"],
  });
  const metadata = appendAgentRunOrigin({
    current,
    ...scope,
    userMessageId: "u",
    graphThreadId: "refresh",
  });
  assert.deepEqual(metadata, {
    marker: "latest",
    agentRunThreadIds: ["original", "refresh"],
  });
  assert.deepEqual(
    appendAgentRunOrigin({
      current: { ...current, metadata },
      ...scope,
      userMessageId: "u",
      graphThreadId: "refresh",
    }),
    metadata,
  );
});
test("origin writes reject foreign user rows, role and tenant scope", () => {
  for (const patch of [
    { id: "other" },
    { role: "assistant" },
    { teamId: "other" },
    { workspaceId: "other" },
    { threadId: "other" },
  ])
    assert.throws(() =>
      appendAgentRunOrigin({
        current: { ...message("u"), ...patch } as MessageRecord,
        ...scope,
        userMessageId: "u",
        graphThreadId: "graph",
      }),
    );
  for (const raw of ["not-array", [""], [1]])
    assert.throws(() => readAgentRunOrigins({ agentRunThreadIds: raw }));
});
test("unrelated human graphs never become a conversation-wide refresh limit", () => {
  const user = message("u", "user", { agentRunThreadIds: ["owned"] });
  const own = message("a", "assistant", {
    userMessageId: "u",
    agentCheckpoint: {
      beforeInput: { threadId: "owned", checkpointId: "010" },
      final: { threadId: "owned", checkpointId: "020" },
    },
  });
  const unrelated = Array.from({ length: 300 }, (_, i) => [
    message(`u${i}`),
    message(`a${i}`, "assistant", {
      userMessageId: `u${i}`,
      agentCheckpoint: {
        final: { threadId: `other-${i}`, checkpointId: "009" },
      },
    }),
  ]).flat();
  const result = collectRefreshAgentRunOrigins({
    ...scope,
    userMessage: user,
    messages: [user, own, ...unrelated],
  });
  assert.deepEqual(result.graphThreadIds, ["owned"]);
  assert.equal(result.checkpointRefs.length, 2);
  assert.equal(result.requireExistingBudget, true);
  assert.deepEqual(result.historyFloors, [
    { threadId: "owned", checkpointId: "010" },
  ]);
});
test("legacy assistant parent ordering is resolved on server records; public policy only prevents unsafe migration", () => {
  const user = message("u"),
    a = message("a", "assistant", {
      agentCheckpoint: { final: { threadId: "legacy", checkpointId: "old" } },
      agentRunProgress: { untrusted: true },
    });
  const result = collectRefreshAgentRunOrigins({
    ...scope,
    userMessage: user,
    messages: [user, a],
  });
  assert.deepEqual(result.graphThreadIds, ["thread", "legacy"]);
  assert.equal(result.requireExistingBudget, true);
  // A server-recorded explicit user identity makes even malformed public policy
  // evidence a reason to fail closed, never a source of reconstructed counters.
  a.metadata.userMessageId = "u";
  assert.equal(
    collectRefreshAgentRunOrigins({
      ...scope,
      userMessage: user,
      messages: [user, a],
    }).requireExistingBudget,
    true,
  );
});

test("lineage safety cap exceeds the default 440 decisions and never silently truncates", () => {
  assert.ok(MAX_AGENT_REFRESH_GRAPH_ORIGINS > 440);
  const ids = Array.from(
    { length: MAX_AGENT_REFRESH_GRAPH_ORIGINS },
    (_, i) => `g${i}`,
  );
  assert.equal(
    readAgentRunOrigins({ agentRunThreadIds: ids }).length,
    MAX_AGENT_REFRESH_GRAPH_ORIGINS,
  );
  assert.throws(() =>
    readAgentRunOrigins({ agentRunThreadIds: [...ids, "overflow"] }),
  );
});
