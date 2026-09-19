// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("./auth-client", () => ({
  authClient: {
    getSession: vi.fn(async () => ({ data: { user: { id: "account-a" } } })),
  },
}));
import { openDesktopPreview } from "./desktop-preview-bridge";

afterEach(() => {
  delete window.__SOURCEWEFT_DESKTOP__;
  vi.unstubAllGlobals();
});
test("transfers an authorized file snapshot without its download URL or credentials", async () => {
  vi.stubGlobal("Blob", NodeBlob);
  const invoke = vi.fn().mockResolvedValue(undefined);
  window.__SOURCEWEFT_DESKTOP__ = { isDesktop: true, invoke, listen: vi.fn() };
  await openDesktopPreview(
    { name: "/work/report.md", text: "# 报告" },
    "My Mac",
    new AbortController().signal,
  );
  expect(invoke).toHaveBeenCalledOnce();
  const [command, { file }] = invoke.mock.calls[0]!;
  expect(command).toBe("open_file_preview");
  expect(file).toMatchObject({
    name: "/work/report.md",
    accountId: "account-a",
    description: "My Mac",
  });
  expect(Buffer.from(file.base64, "base64").toString()).toBe("# 报告");
  expect(Object.keys(file).sort()).toEqual([
    "accountId",
    "base64",
    "description",
    "id",
    "mimeType",
    "name",
  ]);
});
test("cancelling a file request prevents a late native window from opening", async () => {
  vi.stubGlobal("Blob", NodeBlob);
  const invoke = vi.fn();
  window.__SOURCEWEFT_DESKTOP__ = { isDesktop: true, invoke, listen: vi.fn() };
  const controller = new AbortController();
  controller.abort();
  await expect(
    openDesktopPreview({ name: "a.txt", text: "a" }, "", controller.signal),
  ).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});
