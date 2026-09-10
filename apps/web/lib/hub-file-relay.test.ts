// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  createHubFileClient,
  serveHubFileRequest,
  validateHubFileRequest,
  type HubFileRequest,
  type HubFileResult,
} from "./hub-file-relay";
import type { HubSnapshot } from "../app/dashboard/chat/_components/hub-protocol";

const snapshot = {
  sessionId: "session",
  accountId: "account",
  contextKey: "workspace/thread",
  phase: "active",
  data: { workspaceId: "workspace", threadId: "thread" },
} as HubSnapshot;
const path = "/v1/workspaces/workspace/threads/thread/local-files";
const request: HubFileRequest = {
  id: "request",
  sessionId: "session",
  contextKey: "workspace/thread",
  path,
};
afterEach(() => vi.useRealTimers());

it("binary preview uses the authorized reader and rejects mixed operations", async () => {
  const previewRequest = {
    ...request,
    path: path + "?path=deck.pptx&download=true",
    preview: true,
  };
  expect(validateHubFileRequest(previewRequest, snapshot)).toBe(snapshot);
  expect(() =>
    validateHubFileRequest(
      { ...previewRequest, downloadName: "deck.pptx" },
      snapshot,
    ),
  ).toThrow();
  expect(() =>
    validateHubFileRequest({ ...previewRequest, path }, snapshot),
  ).toThrow();
  const preview = vi.fn(async () => ({
    base64: "AP8=",
    mimeType: "application/octet-stream",
  }));
  const download = vi.fn();
  const read = vi.fn();
  const send = vi.fn();
  await serveHubFileRequest(previewRequest, {
    current: () => snapshot,
    authorize: vi.fn(),
    preview,
    read,
    download,
    send,
  });
  expect(preview).toHaveBeenCalledWith(previewRequest.path);
  expect(download).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(JSON.parse(send.mock.calls[0]![0].chunk).base64).toBe("AP8=");
});

it("only relays the active conversation's local file endpoint", () => {
  expect(validateHubFileRequest(request, snapshot)).toBe(snapshot);
  for (const invalid of [
    "https://external.example" + path,
    "//external.example" + path,
    "/v1/workspaces/other/threads/thread/local-files",
    path + "/../local-devices",
    "/v1/local-devices/enroll",
    path + "?path=a&path=b",
    path + "?download=true",
    path + "?unknown=1",
  ])
    expect(() =>
      validateHubFileRequest({ ...request, path: invalid }, snapshot),
    ).toThrow();
  expect(() =>
    validateHubFileRequest(request, { ...snapshot, contextKey: "other" }),
  ).toThrow(/conversation changed/);
  expect(() =>
    validateHubFileRequest(request, { ...snapshot, sessionId: "other" }),
  ).toThrow();
  expect(() =>
    validateHubFileRequest(request, { ...snapshot, phase: "away" }),
  ).toThrow();
});

it("executes authenticated reads in main and sends only file data back, including large escaped text", async () => {
  const data = { content: "\u0001".repeat(1024 * 1024) };
  const authorize = vi.fn(async () => ({ proof: "main-only-proof" }));
  const read = vi.fn(async () => data);
  const replies: HubFileResult[] = [];
  const client: ReturnType<typeof createHubFileClient> = createHubFileClient({
    current: () => snapshot,
    connected: () => true,
    send: async (r) => {
      await serveHubFileRequest(r, {
        current: () => snapshot,
        authorize,
        read,
        download: vi.fn(),
        send: async (reply) => {
          replies.push(reply);
          client.receive(reply);
        },
      });
    },
  });
  expect(await client.request(path + "?path=note.txt&content=true")).toEqual(
    data,
  );
  expect(authorize).toHaveBeenCalledWith("account");
  expect(read).toHaveBeenCalledWith(path + "?path=note.txt&content=true");
  expect(replies.length).toBeGreaterThan(1);
  expect(JSON.stringify(replies)).not.toContain("main-only-proof");
  expect(
    replies.every((reply) => JSON.stringify(reply).length < 4 * 1024 * 1024),
  ).toBe(true);
});

it("rejects stale requests before authorization or disk access and never returns late data to a different conversation", async () => {
  const authorize = vi.fn();
  const read = vi.fn();
  const send = vi.fn();
  await serveHubFileRequest(request, {
    current: () => ({ ...snapshot, contextKey: "B" }),
    authorize,
    read,
    download: vi.fn(),
    send,
  });
  expect(authorize).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(send.mock.calls[0]![0].error.message).toContain(
    "conversation changed",
  );
  let current = snapshot;
  send.mockClear();
  await serveHubFileRequest(request, {
    current: () => current,
    authorize,
    read: async () => {
      current = { ...snapshot, contextKey: "B" };
      return { secretFile: "from A" };
    },
    download: vi.fn(),
    send,
  });
  expect(JSON.stringify(send.mock.calls)).not.toContain("from A");
});

it("downloads in the main window without transferring binary bytes or proof", async () => {
  const download = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn();
  await serveHubFileRequest(
    {
      ...request,
      path: path + "?path=file.bin&download=true",
      downloadName: "file.bin",
    },
    {
      current: () => snapshot,
      authorize: vi.fn(),
      read: vi.fn(),
      download,
      send,
    },
  );
  expect(download).toHaveBeenCalledWith(
    path + "?path=file.bin&download=true",
    "file.bin",
  );
  expect(send.mock.calls[0]![0].chunk).toBe("null");
});

it("preserves permission failures instead of falling back to remote access", async () => {
  const client: ReturnType<typeof createHubFileClient> = createHubFileClient({
    current: () => snapshot,
    connected: () => true,
    send: async (r) => {
      await serveHubFileRequest(r, {
        current: () => snapshot,
        authorize: async () => {
          throw Object.assign(new Error("Expired"), {
            code: "NATIVE_PROOF_EXPIRED",
            status: 403,
          });
        },
        read: vi.fn(),
        download: vi.fn(),
        send: async (reply) => client.receive(reply),
      });
    },
  });
  await expect(client.request(path)).rejects.toMatchObject({
    message: "Expired",
    code: "NATIVE_PROOF_EXPIRED",
    status: 403,
  });
});

it("cleans up interrupted requests without silently retrying against another source", async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockResolvedValue(undefined);
  const client = createHubFileClient({
    current: () => snapshot,
    connected: () => true,
    send,
  });
  const value = client.request(path);
  const check = expect(value).rejects.toThrow("Hub session ended");
  client.cancel("Hub session ended");
  await check;
  await vi.runAllTimersAsync();
  expect(send).toHaveBeenCalledTimes(1);
});
