import { createHash, randomUUID } from "node:crypto";
import { test, expect } from "vitest";
import { createRunScopedWorkBlobService } from "./work-blob-service";

const integrationEnabled =
  process.env.SOURCEWEFT_RUN_S3_INTEGRATION_TESTS === "1" &&
  Boolean(process.env.S3_ENDPOINT) &&
  Boolean(process.env.S3_BUCKET) &&
  Boolean(process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID) &&
  Boolean(
    process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY,
  );

function digest(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

test.skipIf(!integrationEnabled)(
  "configured S3-compatible storage honors conditional WIP create/read/delete",
  async () => {
    const service = createRunScopedWorkBlobService({
      teamId: `integration-team-${randomUUID()}`,
      workspaceId: `integration-workspace-${randomUUID()}`,
      runId: `integration-run-${randomUUID()}`,
    });
    const bytes = new TextEncoder().encode(`sourceweft-wip-${randomUUID()}`);
    const contentDigest = digest(bytes);
    const input = {
      semanticKey: `integration-semantic-${randomUUID()}`,
      bytes,
      contentType: "application/octet-stream",
      contentDigest,
      ttlSeconds: 300,
    };

    try {
      const first = await service.putIfAbsent(input);
      const replay = await service.putIfAbsent(input);
      expect(replay).toEqual(first);
      await expect(
        service.getVerified({
          blobRef: first.blobRef,
          contentDigest,
        }),
      ).resolves.toEqual({ bytes, contentType: input.contentType });
      await expect(
        service.getBySemanticKey({ semanticKey: input.semanticKey }),
      ).resolves.toMatchObject({
        blobRef: first.blobRef,
        contentDigest,
      });
    } finally {
      await service.deleteScope();
    }

    await expect(
      service.getBySemanticKey({ semanticKey: input.semanticKey }),
    ).resolves.toBeNull();
  },
);
