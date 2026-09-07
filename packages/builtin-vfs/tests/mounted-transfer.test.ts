import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BackendProtocolV2,
  FileDownloadResponse,
  FileUploadResponse,
} from "deepagents";
import { MountedAgentFilesystemBackend } from "../src/mounted-backend";

function mount(): BackendProtocolV2 {
  return {
    ls: () => ({ files: [] }),
    read: () => ({ content: "" }),
    readRaw: () => ({ error: "unused" }),
    grep: () => ({ matches: [] }),
    glob: () => ({ files: [] }),
    write: (path) => ({ path }),
    edit: (path) => ({ path, occurrences: 1 }),
  };
}

const paths = ["/workfiles/a", "/workfiles/b"];
const bytes = new Uint8Array([0, 255, 128]);
const files: Array<[string, Uint8Array]> = paths.map((path) => [path, bytes]);
function filesystem(working: Partial<BackendProtocolV2>) {
  return new MountedAgentFilesystemBackend({
    knowledge: mount(),
    working: { ...mount(), ...working },
  });
}

for (const synchronous of [true, false]) {
  test(`batch transport failures produce one error per file (${synchronous ? "throw" : "reject"})`, async () => {
    const fail = () => {
      const error = new Error("EACCES: permission denied");
      if (synchronous) throw error;
      return Promise.reject(error);
    };
    const backend = filesystem({ uploadFiles: fail, downloadFiles: fail });
    for (const results of [
      await backend.uploadFiles(files),
      await backend.downloadFiles(paths),
    ]) {
      assert.deepEqual(
        results.map((result) => result.path),
        paths,
      );
      assert.ok(
        results.every((result) => result.error === "permission_denied"),
      );
    }
  });
}

test("batch transfer preserves empty/binary success and individual failure in input order", async () => {
  const backend = filesystem({
    uploadFiles: (batch) =>
      batch.map(([path], index) => ({
        path,
        error: index ? "permission_denied" : null,
      })),
    downloadFiles: (batch) =>
      batch.map((path, index) => ({
        path,
        error: null,
        content: index ? bytes : new Uint8Array(),
      })),
  });
  assert.deepEqual(await backend.uploadFiles(files), [
    { path: paths[0], error: null },
    { path: paths[1], error: "permission_denied" },
  ]);
  assert.deepEqual(await backend.downloadFiles(paths), [
    { path: paths[0], error: null, content: new Uint8Array() },
    { path: paths[1], error: null, content: bytes },
  ]);
});

for (const [name, response] of [
  ["non-array", { error: "unavailable" }],
  ["missing", []],
  [
    "extra",
    [
      { path: paths[0], error: null },
      { path: paths[1], error: null },
    ],
  ],
  ["wrong path", [{ path: paths[1], error: null }]],
  ["missing status", [{ path: paths[0] }]],
  ["unknown status", [{ path: paths[0], error: "unknown-error" }]],
] as const) {
  test(`malformed batch response cannot report success: ${name}`, async () => {
    const backend = filesystem({
      uploadFiles: () => response as unknown as FileUploadResponse[],
      downloadFiles: () => response as unknown as FileDownloadResponse[],
    });
    assert.equal(
      (await backend.uploadFiles([files[0]!]))[0]?.error,
      "invalid_path",
    );
    assert.equal(
      (await backend.downloadFiles([paths[0]!]))[0]?.error,
      "invalid_path",
    );
  });
}

test("a download with success but missing bytes is a protocol failure", async () => {
  const backend = filesystem({
    downloadFiles: (batch) =>
      batch.map((path) => ({ path, error: null, content: null })),
  });
  assert.ok(
    (await backend.downloadFiles(paths)).every(
      (result) => result.error === "invalid_path",
    ),
  );
});

test("batch methods keep their receiver and are not called for empty or forbidden paths", async () => {
  let calls = 0;
  const working = {
    ...mount(),
    marker: bytes,
    uploadFiles(batch: Array<[string, Uint8Array]>) {
      calls += 1;
      assert.strictEqual(batch[0]?.[1], this.marker);
      return batch.map(([path]) => ({ path, error: null }));
    },
  };
  const backend = filesystem(working);
  assert.deepEqual(await backend.uploadFiles([]), []);
  assert.equal(
    (await backend.uploadFiles([["/kb/no", bytes]]))[0]?.error,
    "permission_denied",
  );
  assert.equal(calls, 0);
  assert.equal((await backend.uploadFiles([files[0]!]))[0]?.error, null);
  assert.equal(calls, 1);
});
