import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { getCapabilityContributions } from "@sourceweft/capability-runtime";
import { builtinSandboxCapabilityManifest } from "../src/manifest";
import {
  buildSandboxToolDescriptions,
  buildSandboxRuntimePrompt,
  collectSandboxOutputsSchema,
  createSandboxTools,
  prepareSandboxWorkspaceSchema,
  SandboxManager,
  sandboxToolDescriptions,
  sandboxToolInterruptDescriptions,
} from "../src";
import type {
  SandboxOperationStore,
  SandboxProvider,
  SandboxProviderPathPolicy,
  SandboxRuntimeContext,
  SandboxRuntimeLimits,
  SandboxStore,
} from "../src";

const TEST_SANDBOX_PATH_POLICY: SandboxProviderPathPolicy = {
  workspaceRoot: "/workspace",
  defaultCwd: "/workspace",
  prepareTargetRoots: ["/workspace/input", "/workspace"],
  collectSourceRoots: ["/workspace/output", "/workspace"],
  readWriteRoots: ["/workspace", "/tmp/sourceweft"],
};

const TEST_CONTEXT: SandboxRuntimeContext = {
  teamId: "team-sandbox-tools-test",
  workspaceId: "workspace-sandbox-tools-test",
  threadId: "thread-sandbox-tools-test",
  userId: "user-sandbox-tools-test",
  messageId: "message-sandbox-tools-test",
  runId: "run-sandbox-tools-test",
};

const TEST_LIMITS: SandboxRuntimeLimits = {
  ttlSeconds: 3600,
  commandTimeoutMs: 1000,
  maxOutputChars: 10000,
  maxPrepareFileBytes: 10000,
  maxPrepareTotalBytes: 10000,
  maxCollectFileBytes: 10000,
  maxCollectTotalBytes: 10000,
};

function createSandboxStore(): SandboxStore {
  return {
    async findLatestActiveThreadSandbox() {
      return {
        id: "sandbox-record-1",
        provider: "fake",
        providerSandboxId: "provider-sandbox-1",
        teamId: TEST_CONTEXT.teamId,
        workspaceId: TEST_CONTEXT.workspaceId,
        threadId: TEST_CONTEXT.threadId,
        userId: TEST_CONTEXT.userId,
        status: "ready",
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
      };
    },
    async markCreatingSandboxError() {
      return true;
    },
    async insertCreatingSandbox() {
      return true;
    },
    async markSandboxReady() {},
    async markSandboxExpired() {},
    async releaseReadyThreadSandboxLease() {
      return 0;
    },
    async touchSandbox() {},
  };
}

function createOperationStore(): SandboxOperationStore & {
  completed: Array<{
    result?: Record<string, unknown>;
    status: "succeeded" | "failed";
  }>;
} {
  const store: SandboxOperationStore & {
    completed: Array<{
      result?: Record<string, unknown>;
      status: "succeeded" | "failed";
    }>;
  } = {
    completed: [],
    async findLatestToolOperation() {
      return null;
    },
    async insertRunningToolOperation() {
      return true;
    },
    async findLatestActiveToolOperation() {
      return null;
    },
    async markStaleRunningToolOperationFailed() {
      return false;
    },
    async completeToolOperation(input) {
      store.completed.push({
        status: input.status,
        result: input.result,
      });
    },
    async recordOperation() {},
    async findSucceededOperationByToolCall() {
      return null;
    },
  };
  return store;
}

test("sandbox package owns tool manifest and runtime schemas", () => {
  assert.equal(builtinSandboxCapabilityManifest.id, "sourceweft/sandbox");
  const manifest = capabilityManifestSchema.parse(
    builtinSandboxCapabilityManifest,
  );
  assert.deepEqual(
    getCapabilityContributions(manifest).tools.map((tool) => tool.id),
    ["prepare_sandbox_workspace", "execute", "collect_sandbox_outputs"],
  );

  assert.equal(
    prepareSandboxWorkspaceSchema.parse({
      files: [
        {
          sourcePath: "/workfiles/a.txt",
          sandboxPath: "/workspace/input/a.txt",
        },
      ],
    }).files.length,
    1,
  );
  assert.equal(
    collectSandboxOutputsSchema.parse({
      outputs: [
        {
          sandboxPath: "/workspace/output/a.txt",
          target: { kind: "workfile", path: "/workfiles/a.txt" },
        },
      ],
    }).outputs.length,
    1,
  );
  assert.equal(
    sandboxToolInterruptDescriptions.prepare_sandbox_workspace,
    "Materialize selected SourceWeft DB-backed /workfiles Workfile content as ordinary provider sandbox files. Review paths and sizes before transfer.",
  );
  assert.equal(
    sandboxToolInterruptDescriptions.execute,
    "Execute a shell command in the provider sandbox filesystem. Review command intent, network access, and expected outputs before running.",
  );
  assert.equal(
    sandboxToolInterruptDescriptions.collect_sandbox_outputs,
    "Persist selected provider sandbox text outputs into SourceWeft DB-backed /workfiles Workfiles. Review destination paths before persisting output.",
  );
  assert.match(
    sandboxToolDescriptions.execute,
    /SourceWeft DB-backed VFS logical paths such as \/workfiles, \/kb, and \/skills are not mounted/u,
  );
  assert.match(
    sandboxToolDescriptions.prepareSandboxWorkspace,
    /Materialize explicitly selected SourceWeft DB-backed VFS \/workfiles Workfile content as ordinary provider sandbox files/u,
  );
  assert.match(
    sandboxToolDescriptions.prepareSandboxWorkspace,
    /\/kb and \/skills are SourceWeft DB-backed VFS roots, not transfer sources/u,
  );
  assert.match(
    sandboxToolDescriptions.collectSandboxOutputs,
    /Persist explicitly selected provider sandbox text outputs/u,
  );
  assert.match(
    sandboxToolDescriptions.collectSandboxOutputs,
    /Do not use this tool for binary outputs such as \.pptx files/u,
  );
  assert.match(
    sandboxToolDescriptions.collectSandboxOutputs,
    /publish_sandbox_artifact for PPTX slides/u,
  );
  assert.doesNotMatch(
    sandboxToolDescriptions.prepareSandboxWorkspace,
    /\/workspace/u,
  );
  assert.doesNotMatch(sandboxToolDescriptions.execute, /\/workspace/u);
  assert.doesNotMatch(
    sandboxToolDescriptions.collectSandboxOutputs,
    /\/workspace/u,
  );
});

test("sandbox runtime tool descriptions include provider-owned path policy", () => {
  const descriptions = buildSandboxToolDescriptions({
    workspaceRoot: "/task",
    defaultCwd: "/task",
    prepareTargetRoots: ["/task/input"],
    collectSourceRoots: ["/task/results"],
    readWriteRoots: ["/task", "/cache"],
  });

  assert.match(
    descriptions.prepareSandboxWorkspace,
    /Current provider prepare target roots: \/task\/input/u,
  );
  assert.match(descriptions.execute, /Current provider default cwd: \/task/u);
  assert.match(
    descriptions.execute,
    /Current provider read\/write roots: \/task, \/cache/u,
  );
  assert.match(
    descriptions.collectSandboxOutputs,
    /Current provider collect source roots: \/task\/results/u,
  );
  assert.doesNotMatch(descriptions.prepareSandboxWorkspace, /\/workspace/u);
  assert.doesNotMatch(descriptions.execute, /\/workspace/u);
  assert.doesNotMatch(descriptions.collectSandboxOutputs, /\/workspace/u);
});

test("sandbox package schemas reject malformed transfer requests", () => {
  assert.equal(
    prepareSandboxWorkspaceSchema.safeParse({ files: [] }).success,
    false,
  );
  assert.equal(
    collectSandboxOutputsSchema.safeParse({
      outputs: [{ sandboxPath: "", target: { kind: "workfile", path: "" } }],
    }).success,
    false,
  );
});

test("sandbox package owns agent-facing runtime prompt", () => {
  const prompt = buildSandboxRuntimePrompt({
    prepareToolAvailable: true,
    executeAvailable: true,
    collectToolAvailable: false,
    pathPolicy: {
      workspaceRoot: "/task",
      defaultCwd: "/task",
      prepareTargetRoots: ["/task/input"],
      collectSourceRoots: ["/task/output"],
      readWriteRoots: ["/task", "/cache"],
    },
  });

  assert.match(prompt, /<sandbox_rules>/u);
  assert.match(
    prompt,
    /SourceWeft VFS and the provider sandbox filesystem are separate namespaces/u,
  );
  assert.match(prompt, /\/workfiles is SourceWeft DB-backed VFS Workfiles/u);
  assert.match(prompt, /\/kb is SourceWeft DB-backed VFS source evidence/u);
  assert.match(prompt, /\/skills is SourceWeft DB-backed VFS skill guidance/u);
  assert.match(prompt, /not mounted into sandbox command execution/u);
  assert.match(prompt, /not automatically synced/u);
  assert.match(
    prompt,
    /not a \/workfiles directory mount, mirror, root-level copy, or bidirectional sync/u,
  );
  assert.match(
    prompt,
    /\/workfiles, \/kb, and \/skills inside execute are provider sandbox filesystem paths only/u,
  );
  assert.match(prompt, /Provider sandbox workspace root: \/task/u);
  assert.match(prompt, /Provider sandbox prepare targets: \/task\/input/u);
  assert.match(prompt, /Provider sandbox collect sources: \/task\/output/u);
  assert.match(prompt, /explicit selected-content materialization/u);
  assert.match(prompt, /provider sandbox filesystem paths/u);
  assert.match(prompt, /explicit artifact pipelines/u);
  assert.match(
    prompt,
    /Prepared files, collected Workfiles, and sandbox outputs are not citable evidence/u,
  );
  assert.doesNotMatch(prompt, /copy selected SourceWeft/u);
  assert.doesNotMatch(prompt, /copies selected SourceWeft/u);
  assert.doesNotMatch(prompt, /copy \/workfiles/u);
  assert.doesNotMatch(prompt, /\/workspace\/work/u);
  assert.doesNotMatch(prompt, /Daytona sandbox filesystem/u);
  assert.doesNotMatch(prompt, /\/workfiles directory into sandbox/u);
  assert.doesNotMatch(prompt, /Enabled sandbox skills/u);
  assert.doesNotMatch(prompt, /\/skills\/<skill-name>/u);
  assert.doesNotMatch(prompt, /~\/\.creds/u);
  assert.doesNotMatch(prompt, /GITHUB_TOKEN/u);
  assert.doesNotMatch(prompt, /git push/u);
  assert.doesNotMatch(prompt, /export by default/u);
  assert.match(prompt, /prepare_sandbox_workspace/u);
  assert.match(prompt, /execute/u);
  assert.doesNotMatch(prompt, /collect_sandbox_outputs/u);
});

test("sandbox runtime prompt includes default environment only when enabled", () => {
  const unknownPrompt = buildSandboxRuntimePrompt({
    prepareToolAvailable: true,
    executeAvailable: true,
    collectToolAvailable: true,
  });
  assert.doesNotMatch(unknownPrompt, /<sandbox_environment>/u);
  assert.doesNotMatch(unknownPrompt, /npm install pptxgenjs/u);
  assert.match(unknownPrompt, /binary outputs such as \.pptx files/u);
  assert.match(unknownPrompt, /publish_sandbox_artifact for PPTX slides/u);

  const defaultPrompt = buildSandboxRuntimePrompt({
    prepareToolAvailable: true,
    executeAvailable: true,
    collectToolAvailable: true,
    defaultEnvironmentAvailable: true,
  });
  assert.match(defaultPrompt, /<sandbox_environment>/u);
  assert.match(defaultPrompt, /Node\.js 22/u);
  assert.match(defaultPrompt, /pptxgenjs/u);
  assert.match(defaultPrompt, /markitdown\[pptx\]/u);
  assert.match(defaultPrompt, /Chromium via Playwright/u);
  assert.match(
    defaultPrompt,
    /Do not run installs such as npm install pptxgenjs/u,
  );
});

test("collect_sandbox_outputs returns a recoverable error for binary PPTX output", async () => {
  const operationStore = createOperationStore();
  const writes: Array<{ content: string; path: string }> = [];
  const provider: SandboxProvider = {
    id: "fake",
    pathPolicy: TEST_SANDBOX_PATH_POLICY,
    async createSandbox() {
      return { id: "provider-sandbox-1" };
    },
    async getSandbox() {
      return {};
    },
    async deleteSandbox() {},
    async execute() {
      return { output: "", exitCode: 0, truncated: false };
    },
    async uploadFile() {},
    async ensureDirectory() {},
    async downloadFile() {
      return Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    },
  };
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore,
    ttlSeconds: TEST_LIMITS.ttlSeconds,
    commandTimeoutMs: TEST_LIMITS.commandTimeoutMs,
  });
  const tools = createSandboxTools({
    filesystem: {
      readRaw: async () => ({ error: "not found" }),
      write: async (path: string, content: string) => {
        writes.push({ path, content });
        return { path };
      },
    } as never,
    manager,
    context: TEST_CONTEXT,
    limits: TEST_LIMITS,
  });
  const collectTool = tools.find(
    (candidate) => candidate.name === "collect_sandbox_outputs",
  );
  assert.ok(collectTool);

  const toolOutput = await collectTool.invoke(
    {
      outputs: [
        {
          sandboxPath: "/workspace/ppt-deck/output/feynman-method.pptx",
          target: {
            kind: "workfile",
            path: "/workfiles/ppt-deck/feynman-method.pptx",
          },
        },
      ],
    },
    {
      toolCall: {
        id: "collect-call-1",
        type: "tool_call",
        name: "collect_sandbox_outputs",
        args: {},
      },
    },
  );
  const outputContent =
    toolOutput && typeof toolOutput === "object" && "content" in toolOutput
      ? (toolOutput as { content?: unknown }).content
      : toolOutput;
  const output = JSON.parse(String(outputContent));

  assert.deepEqual(output, {
    ok: false,
    type: "sandbox_collect_error",
    status: "failed",
    code: "SANDBOX_BINARY_OUTPUT_UNSUPPORTED",
    message:
      "SANDBOX_BINARY_OUTPUT_UNSUPPORTED: /workspace/ppt-deck/output/feynman-method.pptx appears to be binary. Use publish_sandbox_artifact for supported binary artifacts such as PPTX files.",
    sandboxPath: "/workspace/ppt-deck/output/feynman-method.pptx",
    recoverable: true,
  });
  assert.deepEqual(writes, []);
  assert.deepEqual(operationStore.completed, [
    {
      status: "succeeded",
      result: output,
    },
  ]);
});
