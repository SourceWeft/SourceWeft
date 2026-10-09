import assert from "node:assert/strict";
import { test } from "node:test";
import { retryTransientSourceRead } from "../src/source-read";
test("transient socket failures retry the identical read, permanent failures do not", async () => {
  let calls = 0;
  const result = await retryTransientSourceRead(async () => {
    calls++;
    if (calls === 1)
      throw new Error("socket", { cause: { code: "ECONNRESET" } });
    return "same bytes";
  });
  assert.equal(calls, 2);
  assert.equal(result, "same bytes");
  let permanent = 0;
  await assert.rejects(
    retryTransientSourceRead(async () => {
      permanent++;
      throw Object.assign(new Error("size"), { code: "ARCHIVE_TOO_LARGE" });
    }),
    /size/,
  );
  assert.equal(permanent, 1);
});
test("a cancelled source read never retries", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    retryTransientSourceRead(async () => {
      calls++;
      controller.abort(new Error("deadline"));
      throw Object.assign(new Error("socket"), { code: "ECONNRESET" });
    }, controller.signal),
    /socket/,
  );
  assert.equal(calls, 1);
});
