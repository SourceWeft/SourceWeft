import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createMessageRenderBlockBuilder } from "../../turn/render-blocks";
import { createSourceWeftToolCallContextMiddleware } from "../middleware/tool-call-context";

const hostMocks = vi.hoisted(() => ({
  deleteArtifactObjectsByPrefix: vi.fn(async () => undefined),
  publishCurrentRunArtifact: vi.fn(),
  readAuthorizedArtifactRecord: vi.fn(),
}));

vi.mock(
  "../../../artifacts/authorized-version-service",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../artifacts/authorized-version-service")
      >();
    return {
      ...actual,
      readAuthorizedArtifactRecord: hostMocks.readAuthorizedArtifactRecord,
    };
  },
);

vi.mock("../../../sources/storage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../sources/storage")>();
  return {
    ...actual,
    deleteArtifactObjectsByPrefix: hostMocks.deleteArtifactObjectsByPrefix,
  };
});

vi.mock(
  "../../../artifacts/current-run-publication",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../artifacts/current-run-publication")
      >();
    return {
      ...actual,
      currentRunArtifactPublicationService: {
        ...actual.currentRunArtifactPublicationService,
        publish: hostMocks.publishCurrentRunArtifact,
      },
    };
  },
);

const { createCapabilityAgentToolHostServices } =
  await import("./host-services");

function createHostServices() {
  return createCapabilityAgentToolHostServices(
    {
      billing: {} as never,
      prepared: {
        threadRunId: "run-1",
        workspace: { id: "workspace-1", organizationId: "team-1" },
        thread: { id: "thread-1" },
        userId: "user-1",
        userMessage: { id: "message-1" },
      } as never,
      runtime: {
        citationRegistry: {},
        retrievalCallOrder: [],
        renderBlocks: createMessageRenderBlockBuilder(),
      } as never,
      sandboxRuntime: null,
    },
    { webProvider: null },
  );
}

let toolCallSequence = 0;

async function withToolCall<T>(input: {
  run: () => Promise<T>;
  subagentType?: string;
  toolName?: string;
}) {
  toolCallSequence += 1;
  const middleware = createSourceWeftToolCallContextMiddleware({
    subagentType: input.subagentType,
  }) as unknown as {
    wrapToolCall: (
      request: unknown,
      handler: (request: unknown) => Promise<T>,
    ) => Promise<T>;
  };
  return middleware.wrapToolCall(
    {
      toolCall: {
        id: `host-protected-call-${toolCallSequence}`,
        name: input.toolName ?? "publish_video_presentation",
        args: {},
      },
    },
    input.run,
  );
}

function createPublicationInput(artifactId: string) {
  return {
    artifactType: "video_presentation",
    mode: { kind: "create" as const, artifactId },
    payload: {},
    prompt: "Create a video",
    semanticRequestKey: "video:request",
    title: "Video",
    workflowVersion: "video-presentation-agent",
  };
}

function committedResult(input: { artifactId: string; reused: boolean }) {
  return {
    ok: true as const,
    result: {
      status: "ready" as const,
      type: "committed_artifact_result" as const,
      artifactType: "video_presentation",
      artifactId: input.artifactId,
      artifactVersionId: "version-1",
      artifactOutputBlockId: `artifact-output:run-1:${input.artifactId}:version-1`,
      workflowVersion: "video-presentation-agent",
    },
    reused: input.reused,
    versionNo: 1,
  };
}

beforeEach(() => {
  hostMocks.deleteArtifactObjectsByPrefix.mockReset();
  hostMocks.deleteArtifactObjectsByPrefix.mockResolvedValue(undefined);
  hostMocks.publishCurrentRunArtifact.mockReset();
  hostMocks.readAuthorizedArtifactRecord.mockReset();
});

test("artifact pre-reads use the host actor and refuse another tenant or workspace", async () => {
  const services = createHostServices();
  const query = {
    teamId: "team-1",
    workspaceId: "workspace-1",
    artifactId: "artifact-1",
  };
  hostMocks.readAuthorizedArtifactRecord.mockResolvedValue(null);

  assert.equal(await services.artifacts.findArtifact(query), null);
  assert.deepEqual(hostMocks.readAuthorizedArtifactRecord.mock.calls, [
    [
      {
        workspaceId: "workspace-1",
        userId: "user-1",
        artifactId: "artifact-1",
      },
    ],
  ]);
  assert.equal(
    await services.artifacts.findArtifact({ ...query, teamId: "other-team" }),
    null,
  );
  assert.equal(
    await services.artifacts.findArtifact({
      ...query,
      workspaceId: "other-workspace",
    }),
    null,
  );
  assert.equal(hostMocks.readAuthorizedArtifactRecord.mock.calls.length, 1);
});

test("cleanupPreallocatedArtifact requires an active root tool context", async () => {
  const services = createHostServices();
  const publications = services.currentRunArtifacts;
  assert.ok(publications);
  const artifactId = publications.allocateArtifactId();

  await assert.rejects(
    () => publications.cleanupPreallocatedArtifact(artifactId),
    /PROTECTED_AGENT_TOOL_CONTEXT_MISMATCH/,
  );
  await assert.rejects(
    () =>
      withToolCall({
        subagentType: "general-purpose",
        run: () => publications.cleanupPreallocatedArtifact(artifactId),
      }),
    /PROTECTED_AGENT_TOOL_CONTEXT_MISMATCH/,
  );
  assert.equal(hostMocks.deleteArtifactObjectsByPrefix.mock.calls.length, 0);

  await withToolCall({
    run: () => publications.cleanupPreallocatedArtifact(artifactId),
  });
  assert.deepEqual(hostMocks.deleteArtifactObjectsByPrefix.mock.calls, [
    [{ prefix: `workspaces/workspace-1/artifacts/${artifactId}/` }],
  ]);
});

test("a successful same-id create consumes its cleanup authority", async () => {
  const services = createHostServices();
  const publications = services.currentRunArtifacts;
  assert.ok(publications);
  const artifactId = publications.allocateArtifactId();
  hostMocks.publishCurrentRunArtifact.mockResolvedValueOnce(
    committedResult({ artifactId, reused: false }),
  );

  const result = await withToolCall({
    run: () =>
      publications.publishCommitted(createPublicationInput(artifactId)),
  });

  assert.equal(result.ok, true);
  await assert.rejects(
    () =>
      withToolCall({
        run: () => publications.cleanupPreallocatedArtifact(artifactId),
      }),
    /ARTIFACT_PREALLOCATION_NOT_OWNED/,
  );
  assert.equal(hostMocks.deleteArtifactObjectsByPrefix.mock.calls.length, 0);
});

test("a reused different-id create leaves only the orphan preallocation cleanable", async () => {
  const services = createHostServices();
  const publications = services.currentRunArtifacts;
  assert.ok(publications);
  const orphanArtifactId = publications.allocateArtifactId();
  const reusedArtifactId = "existing-artifact";
  hostMocks.publishCurrentRunArtifact.mockResolvedValueOnce(
    committedResult({ artifactId: reusedArtifactId, reused: true }),
  );

  const result = await withToolCall({
    run: () =>
      publications.publishCommitted(createPublicationInput(orphanArtifactId)),
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.result.artifactId : null, reusedArtifactId);

  await assert.rejects(
    () =>
      withToolCall({
        run: () => publications.cleanupPreallocatedArtifact(reusedArtifactId),
      }),
    /ARTIFACT_PREALLOCATION_NOT_OWNED/,
  );
  await withToolCall({
    run: () => publications.cleanupPreallocatedArtifact(orphanArtifactId),
  });
  await assert.rejects(
    () =>
      withToolCall({
        run: () => publications.cleanupPreallocatedArtifact(orphanArtifactId),
      }),
    /ARTIFACT_PREALLOCATION_NOT_OWNED/,
  );
  assert.deepEqual(hostMocks.deleteArtifactObjectsByPrefix.mock.calls, [
    [
      {
        prefix: `workspaces/workspace-1/artifacts/${orphanArtifactId}/`,
      },
    ],
  ]);
});
