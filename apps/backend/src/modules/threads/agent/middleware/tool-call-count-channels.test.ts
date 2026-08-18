import assert from "node:assert/strict";
import { schemaMetaRegistry } from "@langchain/langgraph/zod";
import { getInteropZodObjectShape } from "@langchain/core/utils/types";
import { test } from "vitest";
import {
  createSourceWeftToolCallCountChannelsMiddleware,
  mergeToolCallCounts,
} from "./tool-call-count-channels";

test("mergeToolCallCounts folds concurrent writes by element-wise max", () => {
  // Three parallel subagents each report a thread count in the same superstep.
  const folded = [{ __all__: 4 }, { __all__: 4 }, { __all__: 4 }].reduce<
    Record<string, number>
  >((acc, update) => mergeToolCallCounts(acc, update), {});
  assert.deepEqual(folded, { __all__: 4 });
});

test("mergeToolCallCounts keeps the highest per-key count", () => {
  assert.deepEqual(
    mergeToolCallCounts({ __all__: 3, search: 1 }, { __all__: 2, search: 5 }),
    { __all__: 3, search: 5 },
  );
});

test("mergeToolCallCounts treats an empty update as a reset", () => {
  // toolCallLimitMiddleware's afterAgent emits {} to reset the run count.
  assert.deepEqual(mergeToolCallCounts({ __all__: 9 }, {}), {});
  assert.deepEqual(mergeToolCallCounts({ __all__: 9 }, undefined), {});
});

test("mergeToolCallCounts starts from an empty base", () => {
  assert.deepEqual(mergeToolCallCounts(undefined, { __all__: 1 }), {
    __all__: 1,
  });
});

test("count channels declare a reducer so they are not LastValue", () => {
  const middleware = createSourceWeftToolCallCountChannelsMiddleware();
  const shape = getInteropZodObjectShape(middleware.stateSchema as never);
  for (const key of ["threadToolCallCount", "runToolCallCount"]) {
    const field = (shape as Record<string, unknown>)[key];
    const meta = schemaMetaRegistry.get(field as never);
    assert.ok(
      meta?.reducer,
      `${key} must carry a reducer to accept concurrent writes`,
    );
  }
});
