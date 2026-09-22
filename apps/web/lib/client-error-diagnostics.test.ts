// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import {
  buildClientErrorDiagnostic,
  listenForClientErrors,
  reportClientError,
} from "./client-error-diagnostics";

it("retains bundle coordinates and a conversation id without error payloads, tokens or external URLs", () => {
  const error = new TypeError("password=private-chat-content");
  error.stack =
    "TypeError: private-chat-content\n at secretFunction (https://sourceweft.com/_next/static/chunks/abc.js:1:22?token=secret)\n at https://evil.com/private.js:2:3\n at https://sourceweft.com/api/private?key=secret";
  const result = buildClientErrorDiagnostic(error, "messages", {
    origin: "https://sourceweft.com",
    pathname: "/dashboard/chat/7afd34b4-ff40-41e4-b786-b5686edb9180",
  });
  expect(result.name).toBe("TypeError");
  expect(result.threadId).toBe("7afd34b4-ff40-41e4-b786-b5686edb9180");
  expect(result.frames).toEqual(["/_next/static/chunks/abc.js:1:22"]);
  expect(JSON.stringify(result)).not.toMatch(/secret|private|password|evil/);
  expect(
    buildClientErrorDiagnostic({ message: "secret" }, "promise", {
      origin: "https://sourceweft.com",
      pathname: "/auth/token-secret",
    }).threadId,
  ).toBeUndefined();
});

it("deduplicates error objects and removes both global listeners on cleanup", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const target = new EventTarget();
  const stop = listenForClientErrors(target);
  const failure = new Error("secret");
  try {
    target.dispatchEvent(new ErrorEvent("error", { error: failure }));
    reportClientError(failure, "messages");
    expect(log).toHaveBeenCalledTimes(1);
    const event = new Event("unhandledrejection", { cancelable: true });
    Object.defineProperty(event, "reason", {
      value: new Error("another secret"),
    });
    target.dispatchEvent(event);
    expect(log).toHaveBeenCalledTimes(2);
    const cancelled = new Event("unhandledrejection", { cancelable: true });
    cancelled.preventDefault();
    target.dispatchEvent(cancelled);
    expect(log).toHaveBeenCalledTimes(2);
    stop();
    target.dispatchEvent(new ErrorEvent("error", { error: new Error("late") }));
    target.dispatchEvent(event);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  } finally {
    stop();
    log.mockRestore();
  }
});
