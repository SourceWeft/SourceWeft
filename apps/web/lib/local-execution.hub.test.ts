// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { registerHubFileRequester } from "./hub-file-relay";
import { localRequest } from "./local-execution";
import { downloadLocalFile } from "./local-file-download";
const native = vi.hoisted(() => ({ headers: vi.fn() }));
vi.mock("./local-host-session", () => ({
  cachedLocalHostHeaders: native.headers,
  clearLocalHostSession: vi.fn(),
}));
afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("routes detached listing, preview and download through main, without an unauthenticated HTTP attempt", async () => {
  window.history.replaceState({}, "", "/dashboard/hub-window");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const relay = vi.fn().mockResolvedValue({ files: [] });
  const stop = registerHubFileRequester(relay);
  const base = "/v1/workspaces/w/threads/t/local-files";
  try {
    await expect(localRequest(base)).resolves.toEqual({ files: [] });
    await localRequest(base + "?path=note.txt&content=true");
    await downloadLocalFile(base + "?path=note.txt&download=true", "note.txt");
    expect(relay).toHaveBeenCalledTimes(3);
    expect(relay).toHaveBeenLastCalledWith(
      base + "?path=note.txt&download=true",
      "note.txt",
      undefined,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(native.headers).not.toHaveBeenCalled();
    await localRequest("/v1/workspaces/w/threads/t/local-execution");
    expect(relay.mock.calls.at(-1)?.[0]).toBe(
      "/v1/workspaces/w/threads/t/local-execution",
    );
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    stop();
  }
  await expect(localRequest(base)).rejects.toThrow("not connected");
  expect(fetch).not.toHaveBeenCalled();
});

it("passes the request path so device discovery does not receive a native proof", async () => {
  window.history.replaceState({}, "", "/dashboard/chat");
  native.headers.mockImplementation(async (path?: string) =>
    path === undefined || path.endsWith("/local-files")
      ? { "X-Local-Proof": "native-proof" }
      : {},
  );
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ devices: [] }),
  });
  vi.stubGlobal("fetch", fetch);

  await expect(localRequest("/v1/local-devices")).resolves.toEqual({
    devices: [],
  });
  expect(native.headers).toHaveBeenCalledWith("/v1/local-devices");
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: {} });

  await localRequest("/v1/local-devices", undefined, { localProof: true });
  expect(native.headers).toHaveBeenLastCalledWith(undefined);
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({
    headers: { "X-Local-Proof": "native-proof" },
  });
});
