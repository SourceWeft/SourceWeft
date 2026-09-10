// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
const session = vi.hoisted(() => ({
  headers: vi.fn(async () => ({ "X-Local-Proof": "native-proof" })),
  clear: vi.fn(),
}));
vi.mock("./local-host-session", () => ({
  cachedLocalHostHeaders: session.headers,
  clearLocalHostSession: session.clear,
}));
vi.mock("./api-base-url", () => ({ apiBaseUrl: "http://localhost:3301" }));
import { downloadLocalFile } from "./local-file-download";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
test("binary downloads carry native authorization and preserve the response bytes", async () => {
  vi.useFakeTimers();
  const bytes = new Blob([new Uint8Array([0, 255, 1])]);
  const fetch = vi.fn(async () => ({ ok: true, blob: async () => bytes }));
  vi.stubGlobal("fetch", fetch);
  const create = vi.fn(() => "blob:test");
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("sample.bin");
      expect(this.getAttribute("href")).toBe("blob:test");
    });
  await downloadLocalFile("/files?download=true", "sample.bin");
  expect(fetch).toHaveBeenCalledWith(
    "http://localhost:3301/files?download=true",
    {
      credentials: "include",
      cache: "no-store",
      headers: { "X-Local-Proof": "native-proof" },
    },
  );
  expect(create).toHaveBeenCalledWith(bytes);
  expect(click).toHaveBeenCalledOnce();
  await vi.runAllTimersAsync();
  expect(revoke).toHaveBeenCalledWith("blob:test");
});
test("expired proof fails the download and clears the cached local session", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        code: "NATIVE_PROOF_EXPIRED",
        message: "Sign in again",
      }),
    })),
  );
  await expect(downloadLocalFile("/files", "file")).rejects.toThrow(
    "Sign in again",
  );
  expect(session.clear).toHaveBeenCalled();
});
