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

test("state schema parses without the count fields so invoke can initialize it", () => {
  // Regression: langchain >=1.5 `initializeMiddlewareStates` zod-parses each
  // middleware stateSchema at invoke time and rejects any required public field
  // that the caller didn't pass, failing the turn with "has required state
  // fields that must be initialized". Only a zod-level default/optional counts
  // here (the withLangGraph channel default is ignored), so both fields must
  // parse a state that omits them.
  const middleware = createSourceWeftToolCallCountChannelsMiddleware();
  const parsed = (middleware.stateSchema as never as {
    parse: (value: unknown) => Record<string, unknown>;
  }).parse({});
  assert.deepEqual(parsed, { threadToolCallCount: {}, runToolCallCount: {} });
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
