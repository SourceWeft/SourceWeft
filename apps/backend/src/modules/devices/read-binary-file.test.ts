import { expect, it, vi } from "vitest";
import { readLocalBinaryFile } from "./read-binary-file";

function fixture(content: Buffer) {
  const call = vi.fn(
    async (action: string, payload: Record<string, unknown>) => {
      if (action === "file.binary.begin")
        return {
          transferId: "transfer",
          sizeBytes: content.length,
          chunkBytes: 512 * 1024,
        };
      if (action === "file.binary.close") return { closed: true };
      const offset = payload.offset as number;
      const end = Math.min(offset + 512 * 1024, content.length);
      return {
        transferId: "transfer",
        offset,
        content: content.subarray(offset, end).toString("base64"),
        done: end === content.length,
      };
    },
  );
  return { call, workspaceId: "workspace", path: "image.png" };
}

it("reads a binary file larger than the text limit in bounded chunks", async () => {
  const bytes = Buffer.alloc(1024 * 1024 + 37, 137);
  const f = fixture(bytes);
  expect(await readLocalBinaryFile(f)).toEqual(bytes);
  expect(
    f.call.mock.calls
      .filter(([action]) => action === "file.binary.chunk")
      .map(([, payload]) => payload.offset),
  ).toEqual([0, 512 * 1024, 1024 * 1024]);
  expect(f.call.mock.lastCall?.[0]).toBe("file.binary.close");
});

it("rejects mixed transfers and still closes the session", async () => {
  const f = fixture(Buffer.alloc(4));
  f.call.mockResolvedValueOnce({
    transferId: "transfer",
    sizeBytes: 4,
    chunkBytes: 512 * 1024,
  });
  f.call.mockResolvedValueOnce({
    transferId: "other",
    offset: 0,
    content: "AAAAAA==",
    done: true,
  });
  await expect(readLocalBinaryFile(f)).rejects.toMatchObject({
    code: "INVALID_FILE_REPLY",
  });
  expect(f.call.mock.lastCall?.[0]).toBe("file.binary.close");
});

it("cancellation closes the session without reusing an aborted signal", async () => {
  const controller = new AbortController();
  const f = fixture(Buffer.alloc(4));
  f.call.mockImplementationOnce(async () => {
    controller.abort();
    return { transferId: "transfer", sizeBytes: 4, chunkBytes: 512 * 1024 };
  });
  await expect(
    readLocalBinaryFile({ ...f, signal: controller.signal }),
  ).rejects.toBeDefined();
  expect(f.call.mock.lastCall?.[0]).toBe("file.binary.close");
});
