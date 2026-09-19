import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  put: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../workspace/guards", () => ({
  requireContentWorkspace: async () => ({
    id: "workspace",
    organizationId: "team",
  }),
}));
vi.mock("../threads/thread/repository", () => ({
  findThreadRecord: async () => ({
    id: "thread",
    visibility: "private",
    createdBy: "owner",
    executionTarget: { kind: "cloud" },
  }),
}));
vi.mock("./repository", () => ({
  countWorkingFileRecords: async () => 0,
  findWorkingFileRecord: mocks.find,
  upsertWorkingFileRecord: mocks.put,
  listWorkingFileRecords: async () => [],
  listWorkingFileRecordsByUpdatedAt: async () => [],
  touchWorkingFileRecord: vi.fn(),
  deleteWorkingFileRecord: vi.fn(),
}));
vi.mock("../sources/storage", () => ({
  uploadFileObject: mocks.upload,
  downloadFileObject: mocks.download,
  deleteArtifactObject: mocks.remove,
}));
vi.mock("../../shared/logger", () => ({ logger: { warn: vi.fn() } }));
import { workingFilesService } from "./service";
const scope = {
  workspaceId: "workspace",
  threadId: "thread",
  userId: "owner",
  path: "/files/data.bin",
};
const bytes = Buffer.from([0, 255, 128, 1]);
const hash = createHash("sha256").update(bytes).digest("hex");
beforeEach(() => {
  vi.resetAllMocks();
  mocks.find.mockResolvedValue(null);
  mocks.upload.mockResolvedValue({ bucket: "bucket", key: "new-object" });
  mocks.put.mockImplementation(async (input) => ({
    id: "file",
    ...input,
    payloadKind: input.object ? "object" : "inline_text",
    storageBucket: input.object?.bucket ?? null,
    storageKey: input.object?.key ?? null,
    contentHash: input.object?.contentHash ?? hash,
  }));
  mocks.remove.mockResolvedValue(undefined);
});

it("stores binary bytes without text decoding or Source creation", async () => {
  const result = await workingFilesService.putBytes({
    ...scope,
    bytes,
    mimeType: "application/octet-stream",
  });
  expect(mocks.upload.mock.calls[0]![0].body).toEqual(bytes);
  expect(mocks.put.mock.calls[0]![0]).toMatchObject({
    contentText: "",
    sizeBytes: 4,
    object: { contentHash: hash },
  });
  expect(result.file.payloadKind).toBe("object");
});
it("refuses stale overwrites before uploading a replacement", async () => {
  mocks.find.mockResolvedValue({ contentHash: hash });
  await expect(
    workingFilesService.putBytes({
      ...scope,
      bytes,
      mimeType: "application/octet-stream",
    }),
  ).rejects.toMatchObject({ code: "FILE_CHANGED" });
  expect(mocks.upload).not.toHaveBeenCalled();
});
it("cleans an uncommitted object when cancellation arrives during upload", async () => {
  const signal = new AbortController();
  mocks.upload.mockImplementation(async () => {
    signal.abort();
    return { bucket: "bucket", key: "new-object" };
  });
  await expect(
    workingFilesService.putBytes({
      ...scope,
      bytes,
      mimeType: "application/octet-stream",
      signal: signal.signal,
    }),
  ).rejects.toBeDefined();
  expect(mocks.put).not.toHaveBeenCalled();
  expect(mocks.remove).toHaveBeenCalledWith({
    bucket: "bucket",
    key: "new-object",
  });
});
it("validates stored bytes against their content fingerprint", async () => {
  mocks.find.mockResolvedValue({
    payloadKind: "object",
    storageBucket: "bucket",
    storageKey: "object",
    contentHash: hash,
    sizeBytes: bytes.length,
  });
  mocks.download.mockResolvedValue(Buffer.from("different"));
  await expect(workingFilesService.readBytes(scope)).rejects.toMatchObject({
    code: "FILE_CHANGED",
  });
});
it("does not expose another user's private conversation files", async () => {
  await expect(
    workingFilesService.readBytes({ ...scope, userId: "other" }),
  ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  expect(mocks.find).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
});
