import assert from "node:assert/strict";
import test from "node:test";
import { createSseResponse } from "./helpers";

test("createSseResponse returns the async generator when cancelled", async () => {
  let returned = false;
  let pendingNext: ((value: IteratorResult<string>) => void) | null = null;
  let emitted = false;

  const stream: AsyncGenerator<string> = {
    async next() {
      if (!emitted) {
        emitted = true;
        return { done: false, value: "data: {}\n\n" };
      }

      return new Promise<IteratorResult<string>>((resolve) => {
        pendingNext = resolve;
      });
    },
    async return(value?: unknown) {
      returned = true;
      pendingNext?.({ done: true, value: undefined });
      return { done: true, value: value as string };
    },
    async throw(error?: unknown) {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  const response = createSseResponse(stream);
  const reader = response.getReader();

  assert.equal((await reader.read()).value, "data: {}\n\n");
  await reader.cancel();

  assert.equal(returned, true);
});

test("createSseResponse leaves async generator running when detach cancelled", async () => {
  let returned = false;
  let pendingNext: ((value: IteratorResult<string>) => void) | null = null;
  let emitted = false;
  const resolvePendingNext = () => {
    const resolve = pendingNext;
    pendingNext = null;
    resolve?.({ done: true, value: undefined });
  };

  const stream: AsyncGenerator<string> = {
    async next() {
      if (!emitted) {
        emitted = true;
        return { done: false, value: "data: {}\n\n" };
      }

      return new Promise<IteratorResult<string>>((resolve) => {
        pendingNext = resolve;
      });
    },
    async return(value?: unknown) {
      returned = true;
      resolvePendingNext();
      return { done: true, value: value as string };
    },
    async throw(error?: unknown) {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  const response = createSseResponse(stream, { cancel: "detach" });
  const reader = response.getReader();

  assert.equal((await reader.read()).value, "data: {}\n\n");
  await reader.cancel();

  assert.equal(returned, false);
  resolvePendingNext();
});
