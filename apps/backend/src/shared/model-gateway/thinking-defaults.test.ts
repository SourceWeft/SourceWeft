import assert from "node:assert/strict";
import { test } from "vitest";
import type { ThinkingConfig } from "@sourceweft/model-gateway";
import {
  applyThinkingSupportDefaults,
  readProfileThinkingSupport,
  resolveChatThinkingWithDefaults,
  type ChatProfileThinkingSupportFinder,
} from "./thinking-defaults";

test("readProfileThinkingSupport reads the synced fields leniently", () => {
  assert.equal(readProfileThinkingSupport(null), null);
  assert.equal(readProfileThinkingSupport("nope"), null);
  assert.equal(readProfileThinkingSupport([]), null);
  assert.equal(readProfileThinkingSupport({}), null);
  assert.equal(
    readProfileThinkingSupport({ supportedParameters: "reasoning" }),
    null,
  );

  assert.deepEqual(
    readProfileThinkingSupport({
      supportedParameters: ["reasoning", "", 42, "include_reasoning"],
      supportedEfforts: ["high", "bogus", "none", "low"],
      unrelated: true,
    }),
    {
      supportedParameters: ["reasoning", "include_reasoning"],
      supportedEfforts: ["high", "low"],
    },
  );

  // Efforts alone are still worth surfacing.
  assert.deepEqual(readProfileThinkingSupport({ supportedEfforts: ["medium"] }), {
    supportedEfforts: ["medium"],
  });
});

test("applyThinkingSupportDefaults fills absent fields only", () => {
  const thinking: ThinkingConfig = { enabled: false };
  const filled = applyThinkingSupportDefaults(thinking, {
    supportedParameters: ["reasoning"],
    supportedEfforts: ["high"],
  });
  assert.deepEqual(filled, {
    enabled: false,
    supportedParameters: ["reasoning"],
    supportedEfforts: ["high"],
  });

  // A caller-supplied value wins over the profile's.
  const pinned: ThinkingConfig = {
    enabled: false,
    supportedParameters: ["include_reasoning"],
  };
  const merged = applyThinkingSupportDefaults(pinned, {
    supportedParameters: ["reasoning"],
    supportedEfforts: ["high"],
  });
  assert.deepEqual(merged.supportedParameters, ["include_reasoning"]);
  assert.deepEqual(merged.supportedEfforts, ["high"]);

  // Nothing to fill returns the same reference (no churn on the hot path).
  const complete: ThinkingConfig = {
    enabled: true,
    supportedParameters: ["reasoning"],
    supportedEfforts: ["low"],
  };
  assert.equal(
    applyThinkingSupportDefaults(complete, { supportedParameters: ["x"] }),
    complete,
  );
  assert.equal(applyThinkingSupportDefaults(thinking, null), thinking);
});

function finderStub(result: Awaited<ReturnType<ChatProfileThinkingSupportFinder>>) {
  const calls: Array<{ profileAlias?: string; modelAlias?: string }> = [];
  const finder: ChatProfileThinkingSupportFinder = async (input) => {
    calls.push(input);
    return result;
  };
  return { finder, calls };
}

test("resolveChatThinkingWithDefaults skips lookup when there is nothing to do", async () => {
  const { finder, calls } = finderStub({ supportedParameters: ["reasoning"] });

  // No thinking intent at all.
  assert.equal(
    await resolveChatThinkingWithDefaults({ thinking: undefined, finder }),
    undefined,
  );
  // Already complete.
  const complete: ThinkingConfig = {
    enabled: false,
    supportedParameters: ["reasoning"],
    supportedEfforts: ["high"],
  };
  assert.equal(
    await resolveChatThinkingWithDefaults({ thinking: complete, finder }),
    complete,
  );
  // BYOK resolves its own support facts — a GLOBAL profile must not leak in.
  const byok: ThinkingConfig = { enabled: false };
  assert.equal(
    await resolveChatThinkingWithDefaults({
      thinking: byok,
      executionMode: "BYOK",
      finder,
    }),
    byok,
  );
  assert.equal(
    await resolveChatThinkingWithDefaults({
      thinking: byok,
      byokModelId: "byok_1",
      finder,
    }),
    byok,
  );

  assert.equal(calls.length, 0);
});

test("resolveChatThinkingWithDefaults fills from the profile finder", async () => {
  const { finder, calls } = finderStub({
    supportedParameters: ["reasoning", "include_reasoning"],
    supportedEfforts: ["high", "medium"],
  });

  // The 2026-08-23 incident shape: an explicit disable with no couriered
  // catalog facts. Without the fill, the OpenRouter-family adapter emits no
  // reasoning kwargs and the provider default (thinking ON) silently wins.
  const resolved = await resolveChatThinkingWithDefaults({
    thinking: { enabled: false },
    profileAlias: "chat-default",
    modelAlias: "deepseek-v4-pro",
    finder,
  });
  assert.deepEqual(resolved, {
    enabled: false,
    supportedParameters: ["reasoning", "include_reasoning"],
    supportedEfforts: ["high", "medium"],
  });
  assert.deepEqual(calls, [
    { profileAlias: "chat-default", modelAlias: "deepseek-v4-pro" },
  ]);
});

test("resolveChatThinkingWithDefaults leaves thinking unchanged when no profile matches", async () => {
  const { finder } = finderStub(null);
  const thinking: ThinkingConfig = { enabled: false };
  assert.equal(
    await resolveChatThinkingWithDefaults({
      thinking,
      modelAlias: "unknown-model",
      finder,
    }),
    thinking,
  );
});
