import { afterEach, expect, test, vi } from "vitest";
import { SOURCEWEFT_WEB_RUN_STOP_SUFFIX } from "@sourceweft/sdk";
import { requestThreadRunStop } from "./stop-thread-run";
afterEach(() => vi.unstubAllGlobals());
test("stop uses the existing authenticated cancellation protocol and encodes identifiers", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await requestThreadRunStop("w/1", "t/1", "run-key");
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/v1/workspaces/w%2F1/threads/t%2F1/stream"),
    expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({
        idempotencyKey: `run-key${SOURCEWEFT_WEB_RUN_STOP_SUFFIX}`,
        stream: false,
      }),
    }),
  );
});
