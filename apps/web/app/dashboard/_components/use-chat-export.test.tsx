// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { flush, mountWithIntl, unmountAll } from "@/test/react";

const toasts = vi.hoisted(() => ({
  loading: vi.fn(() => "toast-1"),
  dismiss: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toasts }));

import { useChatExport, type ChatExportDeps } from "./use-chat-export";

let exportChat: (chatId: string) => Promise<void>;

async function mountExport(deps: ChatExportDeps, workspaceId = "ws-1") {
  function Harness() {
    exportChat = useChatExport(workspaceId, deps);
    return null;
  }
  await mountWithIntl(<Harness />);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  toasts.loading.mockClear();
  toasts.dismiss.mockClear();
  toasts.error.mockClear();
});
afterEach(unmountAll);

test("exports the chat and saves the file under the server's name", async () => {
  const blob = new Blob(["# Plan\n"]);
  const deps = {
    exportThread: vi.fn().mockResolvedValue({ blob, fileName: "Plan.md" }),
    save: vi.fn(),
  };
  await mountExport(deps);

  await act(async () => exportChat("chat-1"));

  expect(deps.exportThread).toHaveBeenCalledWith("ws-1", "chat-1", {
    locale: "en",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  expect(deps.save).toHaveBeenCalledWith(blob, "Plan.md");
  expect(toasts.loading).toHaveBeenCalledWith("Preparing export…");
  expect(toasts.dismiss).toHaveBeenCalledWith("toast-1");
  expect(toasts.error).not.toHaveBeenCalled();
});

test("a download without a file name is saved as chat.md", async () => {
  const deps = {
    exportThread: vi
      .fn()
      .mockResolvedValue({ blob: new Blob(["x"]), fileName: null }),
    save: vi.fn(),
  };
  await mountExport(deps);

  await act(async () => exportChat("chat-1"));

  expect(deps.save).toHaveBeenCalledWith(expect.any(Blob), "chat.md");
});

test("a failed export shows an error in place of the loading toast", async () => {
  const deps = {
    exportThread: vi.fn().mockRejectedValue(new Error("offline")),
    save: vi.fn(),
  };
  await mountExport(deps);

  await act(async () => exportChat("chat-1"));

  expect(deps.save).not.toHaveBeenCalled();
  expect(toasts.error).toHaveBeenCalledWith("Couldn't export this chat.", {
    id: "toast-1",
  });
});

test("clicking again while the same chat is exporting does nothing", async () => {
  const pending = deferred<{ blob: Blob; fileName: string }>();
  const deps = {
    exportThread: vi.fn().mockReturnValue(pending.promise),
    save: vi.fn(),
  };
  await mountExport(deps);

  let first!: Promise<void>;
  await act(async () => {
    first = exportChat("chat-1");
    await exportChat("chat-1");
  });
  expect(deps.exportThread).toHaveBeenCalledTimes(1);

  await act(async () => {
    pending.resolve({ blob: new Blob(["x"]), fileName: "a.md" });
    await first;
    await flush(2);
  });
  expect(deps.save).toHaveBeenCalledTimes(1);
});

test("nothing happens without a workspace", async () => {
  const deps = { exportThread: vi.fn(), save: vi.fn() };
  function Harness() {
    exportChat = useChatExport(null, deps);
    return null;
  }
  await mountWithIntl(<Harness />);

  await act(async () => exportChat("chat-1"));

  expect(deps.exportThread).not.toHaveBeenCalled();
});
