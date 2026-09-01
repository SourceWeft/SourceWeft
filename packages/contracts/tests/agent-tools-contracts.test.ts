import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_TOOL_EXECUTION_TIMEOUT_DEFAULT_MS,
  AGENT_TOOL_EXECUTION_TIMEOUT_MIN_MS,
  AGENT_TOOL_HOST_LIMITS,
  committedArtifactToolResultSchema,
  defineAgentTool,
  resolveAgentToolHostInvocationSignal,
  resolveAgentToolTimeoutMs,
  withAgentToolHostInvocationSignal,
  type AgentToolArtifactVersionServices,
  type AgentToolOperationCacheServices,
  type AgentToolReceiptServices,
  type AgentToolSandboxServices,
  type AgentToolWorkBlobServices,
} from "../src/agent-tools/index";

const baseTool = {
  id: "contractTool",
  name: "contract_tool",
  domain: "artifact" as const,
  capabilities: ["artifact"],
  activation: {
    default: "off" as const,
    userControl: "none" as const,
    skill: { declarable: true, activates: true },
  },
};

test("defineAgentTool defaults executionScope to inheritable", () => {
  const tool = defineAgentTool(baseTool);

  assert.equal(tool.executionScope, "inheritable");
});

test("defineAgentTool accepts only finite integer timeout declarations of at least one second", () => {
  const tool = defineAgentTool({
    ...baseTool,
    executionTimeoutMs: 5 * 60_000,
  });

  assert.equal(tool.executionTimeoutMs, 5 * 60_000);

  for (const executionTimeoutMs of [
    0,
    -1,
    999,
    1_000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(() =>
      defineAgentTool({
        ...baseTool,
        executionTimeoutMs,
      }),
    );
  }
});

test("resolveAgentToolTimeoutMs uses the global default and the host hard ceiling", () => {
  assert.equal(AGENT_TOOL_EXECUTION_TIMEOUT_DEFAULT_MS, 120_000);
  assert.equal(AGENT_TOOL_EXECUTION_TIMEOUT_MIN_MS, 1_000);

  assert.equal(
    resolveAgentToolTimeoutMs({
      definition: baseTool,
      hostMaxMs: 10 * 60_000,
    }),
    120_000,
  );
  assert.equal(
    resolveAgentToolTimeoutMs({
      definition: { id: "five-minute-tool", executionTimeoutMs: 5 * 60_000 },
      hostMaxMs: 10 * 60_000,
    }),
    5 * 60_000,
  );
  assert.equal(
    resolveAgentToolTimeoutMs({
      definition: {
        id: "fifteen-minute-tool",
        executionTimeoutMs: 15 * 60_000,
      },
      hostMaxMs: 10 * 60_000,
    }),
    10 * 60_000,
  );
});

test("resolveAgentToolTimeoutMs rejects invalid policy values instead of guessing", () => {
  for (const hostMaxMs of [
    0,
    999,
    1_000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(() =>
      resolveAgentToolTimeoutMs({ definition: baseTool, hostMaxMs }),
    );
  }
  for (const globalDefaultMs of [
    0,
    999,
    1_000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(() =>
      resolveAgentToolTimeoutMs({
        definition: baseTool,
        globalDefaultMs,
        hostMaxMs: 10 * 60_000,
      }),
    );
  }
});

test("model-authored timeout-like arguments cannot change a tool definition timeout", () => {
  const modelArguments = {
    timeout: 60 * 60_000,
    timeoutMs: 60 * 60_000,
    execution_timeout_ms: 60 * 60_000,
  };

  assert.equal(
    resolveAgentToolTimeoutMs({
      definition: defineAgentTool(baseTool),
      hostMaxMs: 10 * 60_000,
      ...modelArguments,
    }),
    AGENT_TOOL_EXECUTION_TIMEOUT_DEFAULT_MS,
  );
});

test("host invocation signals use the configurable side channel", () => {
  const controller = new AbortController();
  const originalSignal = new AbortController().signal;
  const configured = withAgentToolHostInvocationSignal(
    {
      configurable: { thread_id: "thread-1" },
      signal: originalSignal,
    },
    controller.signal,
  );

  assert.equal(
    resolveAgentToolHostInvocationSignal(configured),
    controller.signal,
  );
  assert.equal(
    resolveAgentToolHostInvocationSignal({ config: configured }),
    controller.signal,
  );
  assert.equal(configured.signal, originalSignal);
  assert.equal(
    (configured.configurable as Record<string, unknown>).thread_id,
    "thread-1",
  );
  assert.equal(
    resolveAgentToolHostInvocationSignal({ signal: originalSignal }),
    undefined,
  );
});

test("defineAgentTool preserves root-only scope and committed-artifact terminal result", () => {
  const tool = defineAgentTool({
    ...baseTool,
    executionScope: "root_only",
    terminalResult: {
      kind: "committed_artifact",
      artifactType: "report",
    },
  });

  assert.equal(tool.executionScope, "root_only");
  assert.deepEqual(tool.terminalResult, {
    kind: "committed_artifact",
    artifactType: "report",
  });
});

test("committedArtifactToolResultSchema accepts only exact committed ready facts", () => {
  const result = committedArtifactToolResultSchema.parse({
    status: "ready",
    type: "committed_artifact_result",
    artifactType: "report",
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    artifactOutputBlockId: "artifact-output:run-1:artifact-1:version-1",
    workflowVersion: "video-presentation-agent",
  });

  assert.equal(result.artifactVersionId, "version-1");
  assert.equal(
    committedArtifactToolResultSchema.safeParse({
      ...result,
      status: "processing",
    }).success,
    false,
  );
  assert.equal(
    committedArtifactToolResultSchema.safeParse({
      status: "ready",
      artifactId: "artifact-1",
    }).success,
    false,
  );
});

test("generic Agent-tool host limits are finite positive hard ceilings", () => {
  for (const value of Object.values(AGENT_TOOL_HOST_LIMITS)) {
    assert.equal(Number.isSafeInteger(value), true);
    assert.ok(value > 0);
  }
  assert.ok(
    AGENT_TOOL_HOST_LIMITS.sandboxCaptureMaxTotalBytes >=
      AGENT_TOOL_HOST_LIMITS.workBlobMaxBytes,
  );
});

test("trusted host ports carry capability inputs without tenant or object-key authority", async () => {
  const artifacts: AgentToolArtifactVersionServices = {
    readAuthorizedCurrentVersion: async ({ artifactId }) => ({
      artifactId,
      versionId: "version-1",
      versionNo: 1,
      payload: { kind: "artifact" },
    }),
  };
  const receipts: AgentToolReceiptServices = {
    issueCurrentRunReceipt: async () => ({ receiptId: "receipt-1" }),
    resolveCurrentRunReceipt: async () => ({ status: "passed" }),
  };
  const operations: AgentToolOperationCacheServices = {
    claimMany: async ({ semanticKeys }) => ({
      kind: "claimed",
      items: semanticKeys.map((semanticKey) => ({
        semanticKey,
        action: "execute" as const,
        claimToken: `claim:${semanticKey}`,
      })),
    }),
    complete: async () => ({ observationId: "observation-1" }),
    markUnknown: async () => undefined,
  };
  const sandbox: AgentToolSandboxServices = {
    allowedReadRoots: ["/workspace"],
    downloadCurrentFile: async () => new Uint8Array([1]),
    ensureCurrentSession: async () => ({ sessionGeneration: "session-1" }),
    uploadCurrentFiles: async () => undefined,
    listCurrentFiles: async () => ["/workspace/project.ts"],
    executeCurrent: async () => ({ exitCode: 0, output: "ok" }),
    captureCurrentTree: async () => [
      { relativePath: "project.ts", bytes: new Uint8Array([1]) },
    ],
  };
  const workBlobs: AgentToolWorkBlobServices = {
    putIfAbsent: async ({ contentDigest }) => ({
      blobRef: "blob-1",
      contentDigest,
    }),
    getVerified: async () => ({
      bytes: new Uint8Array([1]),
      contentType: "application/octet-stream",
    }),
    getBySemanticKey: async () => null,
    deleteScope: async () => undefined,
  };

  assert.equal(
    (
      await artifacts.readAuthorizedCurrentVersion({
        artifactId: "artifact-1",
        expectedArtifactType: "report",
      })
    )?.versionNo,
    1,
  );
  assert.equal(
    (
      await receipts.issueCurrentRunReceipt({
        producerToolName: "validate_report",
        producerToolCallId: "call-1",
        schemaVersion: "1",
        payload: { status: "passed" },
      })
    ).receiptId,
    "receipt-1",
  );
  assert.equal(
    (
      await operations.claimMany({
        toolName: "generate_assets",
        toolCallId: "call-2",
        semanticKeys: ["asset:a", "asset:b"],
        executionScope: "root_only",
      })
    ).kind,
    "claimed",
  );
  assert.deepEqual(await sandbox.listCurrentFiles?.({ root: "/workspace" }), [
    "/workspace/project.ts",
  ]);
  assert.equal(
    (
      await workBlobs.putIfAbsent({
        semanticKey: "asset:a",
        bytes: new Uint8Array([1]),
        contentType: "application/octet-stream",
        contentDigest: "sha256:1",
        ttlSeconds: 60,
      })
    ).blobRef,
    "blob-1",
  );
});

// Type-only security tripwires: host identity and physical object keys are not
// accepted from a capability. `check-types` verifies the expected errors.
function hostInjectedIdentityTripwires(
  receipts: AgentToolReceiptServices,
  blobs: AgentToolWorkBlobServices,
) {
  void receipts.issueCurrentRunReceipt({
    producerToolName: "validate_report",
    producerToolCallId: "call-1",
    schemaVersion: "1",
    payload: {},
    // @ts-expect-error run identity is injected by the host
    runId: "run-forged",
  });
  void blobs.putIfAbsent({
    semanticKey: "asset:a",
    bytes: new Uint8Array([1]),
    contentType: "application/octet-stream",
    contentDigest: "sha256:1",
    ttlSeconds: 60,
    // @ts-expect-error physical keys are built by the host
    objectKey: "workspaces/forged/key",
  });
}

void hostInjectedIdentityTripwires;
