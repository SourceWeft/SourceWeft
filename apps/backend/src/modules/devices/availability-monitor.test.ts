import { afterEach, expect, test, vi } from "vitest";
import { watchLocalConversationAvailability } from "./availability-monitor";
afterEach(() => vi.useRealTimers());
test("loss aborts a running conversation exactly once without automatic restart", async () => {
  vi.useFakeTimers();
  const check = vi.fn().mockResolvedValue(undefined);
  const unavailable = vi.fn();
  const stop = watchLocalConversationAvailability(check, unavailable);
  await vi.advanceTimersByTimeAsync(3000);
  expect(unavailable).not.toHaveBeenCalled();
  const error = new Error("PC disconnected");
  check.mockRejectedValue(error);
  await vi.advanceTimersByTimeAsync(9000);
  expect(unavailable).toHaveBeenCalledExactlyOnceWith(error);
  expect(check).toHaveBeenCalledTimes(2);
  stop();
});
test("completion suppresses a late probe failure and overlapping probes", async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const check = vi.fn(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  const unavailable = vi.fn();
  const stop = watchLocalConversationAvailability(check, unavailable);
  await vi.advanceTimersByTimeAsync(9000);
  expect(check).toHaveBeenCalledOnce();
  stop();
  reject(new Error("Late failure"));
  await vi.advanceTimersByTimeAsync(3000);
  expect(unavailable).not.toHaveBeenCalled();
});
