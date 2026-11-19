import assert from "node:assert/strict";
import { schemaMetaRegistry } from "@langchain/langgraph/zod";
import { getInteropZodObjectShape } from "@langchain/core/utils/types";
import { test } from "vitest";
import { createSourceWeftToolCallCountChannelsMiddleware } from "./tool-call-count-channels";

test("state schema parses without the count fields so invoke can initialize it", () => {
  // Regression: langchain >=1.5 `initializeMiddlewareStates` zod-parses each
  // middleware stateSchema at invoke time and rejects any required public field
  // that the caller didn't pass, failing the turn with "has required state
  // fields that must be initialized". Both fields must parse a state that omits
  // them.
  const middleware = createSourceWeftToolCallCountChannelsMiddleware();
  const parsed = (
    middleware.stateSchema as never as {
      parse: (value: unknown) => Record<string, unknown>;
    }
  ).parse({});
  assert.deepEqual(parsed, { threadToolCallCount: {}, runToolCallCount: {} });
});

test("count channels are plain last-value records, as langchain declares them", () => {
  // The merging reducer this middleware once added covered counts that
  // delegates returned to their parent; deepagents no longer forwards them
  // (see parallel-task-call-counts.test.ts).
  const middleware = createSourceWeftToolCallCountChannelsMiddleware();
  const shape = getInteropZodObjectShape(middleware.stateSchema as never);
  for (const key of ["threadToolCallCount", "runToolCallCount"]) {
    const field = (shape as Record<string, unknown>)[key];
    assert.ok(field, `${key} must be declared`);
    assert.equal(schemaMetaRegistry.get(field as never)?.reducer, undefined);
  }
});
