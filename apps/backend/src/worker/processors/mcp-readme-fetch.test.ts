import assert from "node:assert/strict";
import type { Job } from "bullmq";
import { test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ batch: vi.fn() }));

vi.mock("../../modules/market/readme/readme-fetch", () => ({
  fetchMcpReadmeBatch: mocks.batch,
}));

import { processMcpReadmeFetchJob } from "./mcp-readme-fetch";

const job = (data: Record<string, unknown>) =>
  ({ id: "mcp-readme-fetch_scheduled", data }) as unknown as Job<
    Record<string, unknown>
  >;

test("a batch job hands its versions to the batch fetch", async () => {
  mocks.batch.mockResolvedValue({ processed: 2 });
  const result = await processMcpReadmeFetchJob(
    job({ versionIds: ["v-1", "v-2"], reason: "admin" }),
  );
  assert.deepEqual(result, { processed: 2 });
  assert.deepEqual(mocks.batch.mock.calls[0]?.[0], {
    versionIds: ["v-1", "v-2"],
    reason: "admin",
  });
});

test("a job without version ids fails instead of doing nothing", async () => {
  mocks.batch.mockClear();
  for (const data of [{}, { versionIds: "v-1" }, { versionIds: ["v-1", 7] }]) {
    await assert.rejects(
      () => processMcpReadmeFetchJob(job(data)),
      /no versionIds/,
    );
  }
  assert.equal(mocks.batch.mock.calls.length, 0);
});
