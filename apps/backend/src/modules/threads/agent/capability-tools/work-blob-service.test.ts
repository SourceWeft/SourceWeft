import { createHash } from "node:crypto";
import { AGENT_TOOL_HOST_LIMITS } from "@sourceweft/contracts/agent-tools";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createRunScopedWorkBlobService } from "./work-blob-service";

function digest(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

type StoredObject = {
  body: Uint8Array;
  contentType: string;
  metadata: Record<string, string>;
};

function createStore() {
  const objects = new Map<string, StoredObject>();
  return {
    objects,
    putIfAbsent: vi.fn(
      async (input: {
        key: string;
        body: Uint8Array;
        contentType: string;
        metadata?: Record<string, string>;
      }) => {
        if (objects.has(input.key)) return "exists" as const;
        objects.set(input.key, {
          body: input.body,
          contentType: input.contentType,
          metadata: input.metadata ?? {},
        });
        return "created" as const;
      },
    ),
    download: vi.fn(async (input: { key: string }) => {
      const object = objects.get(input.key);
      return object
        ? {
            body: object.body,
            contentType: object.contentType,
            metadata: object.metadata,
          }
        : null;
    }),
    deletePrefix: vi.fn(async (input: { prefix: string }) => {
      for (const key of objects.keys()) {
        if (key.startsWith(input.prefix)) objects.delete(key);
      }
    }),
  };
}

const scope = {
  teamId: "team-1",
  workspaceId: "workspace-1",
  runId: "run-1",
};
const now = new Date("2026-08-28T00:00:00.000Z");

describe("run-scoped work blobs", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
  });

  test("creates one deterministic conditional object and reuses identical bytes", async () => {
    const service = createRunScopedWorkBlobService(scope, {
      now: () => now,
      store,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const input = {
      semanticKey: "sha256:semantic-a",
      bytes,
      contentType: "audio/mpeg",
      contentDigest: digest(bytes),
      ttlSeconds: 60,
    };

    const first = await service.putIfAbsent(input);
    const second = await service.putIfAbsent(input);

    expect(second).toEqual(first);
    expect(first.blobRef).toMatch(/^wip1_[a-f0-9]{64}_[a-f0-9]{64}$/u);
    expect(first.blobRef).not.toContain(scope.workspaceId);
    expect(first.blobRef).not.toContain(input.semanticKey);
    expect(store.objects.size).toBe(1);
    expect(store.putIfAbsent).toHaveBeenCalledTimes(2);
    expect([...store.objects.values()][0]?.metadata).toMatchObject({
      "sourceweft-sha256": digest(bytes),
      "sourceweft-expires-at": "2026-08-28T00:01:00.000Z",
    });
  });

  test("verifies digest metadata and bytes on both read paths", async () => {
    const service = createRunScopedWorkBlobService(scope, {
      now: () => now,
      store,
    });
    const bytes = new Uint8Array([4, 5, 6]);
    const contentDigest = digest(bytes);
    const created = await service.putIfAbsent({
      semanticKey: "semantic-b",
      bytes,
      contentType: "image/png",
      contentDigest,
      ttlSeconds: 60,
    });

    await expect(
      service.getVerified({
        blobRef: created.blobRef,
        contentDigest,
      }),
    ).resolves.toEqual({ bytes, contentType: "image/png" });
    await expect(
      service.getBySemanticKey({ semanticKey: "semantic-b" }),
    ).resolves.toEqual({
      blobRef: created.blobRef,
      bytes,
      contentType: "image/png",
      contentDigest,
    });
  });

  test("rejects mismatched caller digests before the conditional write", async () => {
    const service = createRunScopedWorkBlobService(scope, {
      now: () => now,
      store,
    });

    await expect(
      service.putIfAbsent({
        semanticKey: "semantic-c",
        bytes: new Uint8Array([1]),
        contentType: "audio/mpeg",
        contentDigest: `sha256:${"0".repeat(64)}`,
        ttlSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "WORK_BLOB_DIGEST_MISMATCH" });
    expect(store.putIfAbsent).not.toHaveBeenCalled();
  });

  test("blocks a same-key object whose immutable bytes conflict", async () => {
    const service = createRunScopedWorkBlobService(scope, {
      now: () => now,
      store,
    });
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2]);
    await service.putIfAbsent({
      semanticKey: "semantic-d",
      bytes: first,
      contentType: "audio/mpeg",
      contentDigest: digest(first),
      ttlSeconds: 60,
    });

    await expect(
      service.putIfAbsent({
        semanticKey: "semantic-d",
        bytes: second,
        contentType: "audio/mpeg",
        contentDigest: digest(second),
        ttlSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "WORK_BLOB_INTEGRITY_FAILED" });
  });

  test("rejects cross-run opaque refs without reading the other scope", async () => {
    const first = createRunScopedWorkBlobService(scope, {
      now: () => now,
      store,
    });
    const second = createRunScopedWorkBlobService(
      { ...scope, runId: "run-2" },
      { now: () => now, store },
    );
    const bytes = new Uint8Array([8]);
    const contentDigest = digest(bytes);
    const created = await first.putIfAbsent({
      semanticKey: "semantic-e",
      bytes,
      contentType: "audio/mpeg",
      contentDigest,
      ttlSeconds: 60,
    });
    store.download.mockClear();

    await expect(
      second.getVerified({ blobRef: created.blobRef, contentDigest }),
    ).resolves.toBeNull();
    expect(store.download).not.toHaveBeenCalled();
  });

  test("expires reads and deletes only the deterministic run prefix", async () => {
    let clock = now;
    const service = createRunScopedWorkBlobService(scope, {
      now: () => clock,
      store,
    });
    const bytes = new Uint8Array([9]);
    const contentDigest = digest(bytes);
    const created = await service.putIfAbsent({
      semanticKey: "semantic-f",
      bytes,
      contentType: "application/octet-stream",
      contentDigest,
      ttlSeconds: 1,
    });
    clock = new Date(now.getTime() + 1_001);

    await expect(
      service.getVerified({ blobRef: created.blobRef, contentDigest }),
    ).resolves.toBeNull();
    await service.deleteScope();
    const cleanup = store.deletePrefix.mock.calls[0]?.[0];
    expect(cleanup?.prefix).toMatch(/^agent-wip\/v1\/[a-f0-9]{64}\/$/u);
    expect(store.objects.size).toBe(0);
  });

  test("enforces byte and TTL ceilings before touching object storage", async () => {
    const service = createRunScopedWorkBlobService(scope, {
      now: () => now,
      store,
    });
    const oversized = new Uint8Array(
      AGENT_TOOL_HOST_LIMITS.workBlobMaxBytes + 1,
    );
    await expect(
      service.putIfAbsent({
        semanticKey: "semantic-g",
        bytes: oversized,
        contentType: "application/octet-stream",
        contentDigest: digest(oversized),
        ttlSeconds: 1,
      }),
    ).rejects.toMatchObject({ code: "WORK_BLOB_TOO_LARGE" });
    const oneByte = new Uint8Array([1]);
    await expect(
      service.putIfAbsent({
        semanticKey: "semantic-h",
        bytes: oneByte,
        contentType: "application/octet-stream",
        contentDigest: digest(oneByte),
        ttlSeconds: AGENT_TOOL_HOST_LIMITS.workBlobMaxTtlSeconds + 1,
      }),
    ).rejects.toMatchObject({ code: "WORK_BLOB_TTL_INVALID" });
    expect(store.putIfAbsent).not.toHaveBeenCalled();
  });
});
