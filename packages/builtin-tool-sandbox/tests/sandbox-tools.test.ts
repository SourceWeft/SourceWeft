import assert from "node:assert/strict";
import test from "node:test";
import { capabilityManifestSchema } from "@sourceweft/capability-contracts";
import { getCapabilityContributions } from "@sourceweft/capability-runtime";
import { withAgentToolHostInvocationSignal } from "@sourceweft/contracts/agent-tools";
import { builtinSandboxCapabilityManifest } from "../src/manifest";
import {
  buildSandboxToolDescriptions,
  buildSandboxRuntimePrompt,
  collectSandboxOutputsSchema,
  createSandboxTools,
  maxSandboxCommandTimeoutMs,
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
import { createTrustedSandboxHostAdapter } from "../src/runtime/trusted-host-adapter";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const TEST_SANDBOX_PATH_POLICY: SandboxProviderPathPolicy = {
  workspaceRoot: "/workspace",
  defaultCwd: "/workspace",
  prepareTargetRoots: ["/workspace/input", "/workspace"],
  collectSourceRoots: ["/workspace/output", "/workspace"],
  readWriteRoots: ["/workspace"],
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
  commandBudgetsMs: { interactive: 1000, batch: 4000 },
  maxCommandTimeoutMs: 10000,
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
    async listMessageOperations() {
      return [];
    },
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
    /Never include SourceWeft DB-backed VFS logical paths such as \/workfiles, \/kb, or \/skills/u,
  );
  assert.match(
    sandboxToolDescriptions.execute,
    /they are not sandbox paths even for mkdir, ls, cat, test, node, python, or shell redirection/u,
  );
  assert.match(
    sandboxToolDescriptions.execute,
    /current provider read\/write roots/u,
  );
  assert.match(
    sandboxToolDescriptions.prepareSandboxWorkspace,
    /Materialize explicitly selected SourceWeft DB-backed VFS \/workfiles Workfile content as ordinary provider sandbox files/u,
  );
  assert.match(
    sandboxToolDescriptions.prepareSandboxWorkspace,
    /Put generated code, data files, plans, and QA notes in \/workfiles first/u,
  );
  assert.match(
    sandboxToolDescriptions.prepareSandboxWorkspace,
    /prepare only files needed for sandbox execution/u,
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
    /Do not use this tool for binary outputs such as \.pptx, \.pdf, \.zip, or \.xlsx files/u,
  );
  assert.match(
    sandboxToolDescriptions.collectSandboxOutputs,
    /artifactType=slides for PPTX decks or artifactType=file/u,
  );
  assert.doesNotMatch(
    sandboxToolDescriptions.prepareSandboxWorkspace,
    /\/workspace/u,
  );
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
  assert.match(
    prompt,
    /Never include \/workfiles, \/kb, or \/skills in an execute command/u,
  );
  assert.match(
    prompt,
    /even for mkdir, ls, cat, test, node, python, or shell redirection/u,
  );
  assert.match(prompt, /Provider sandbox workspace root: \/task/u);
  assert.match(prompt, /Provider sandbox prepare targets: \/task\/input/u);
  assert.match(prompt, /Provider sandbox collect sources: \/task\/output/u);
  assert.match(prompt, /scratch files, QA renders, thumbnails, and artifacts/u);
  assert.match(prompt, /Do not use \/tmp for those files/u);
  assert.match(prompt, /explicit selected-content materialization/u);
  assert.match(
    prompt,
    /Put command inputs such as generated code, data files, plans, and QA notes in \/workfiles first/u,
  );
  assert.match(
    prompt,
    /Commands needing Workfiles should prepare the selected \/workfiles\/\.\.\. files/u,
  );
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
  assert.doesNotMatch(prompt, /\/tmp\/sourceweft/u);
  assert.doesNotMatch(prompt, /~\/\.creds/u);
  assert.doesNotMatch(prompt, /GITHUB_TOKEN/u);
  assert.doesNotMatch(prompt, /git push/u);
  assert.doesNotMatch(prompt, /export by default/u);
  assert.match(prompt, /prepare_sandbox_workspace/u);
  assert.match(prompt, /execute/u);
  assert.doesNotMatch(prompt, /collect_sandbox_outputs/u);
});

test("sandbox runtime prompt admits staged /skills scripts only when skill staging is on", () => {
  const capabilities = {
    prepareToolAvailable: true,
    executeAvailable: true,
    collectToolAvailable: false,
  } as const;

  const staged = buildSandboxRuntimePrompt({
    ...capabilities,
    skillScriptsStaged: true,
  });
  assert.match(staged, /materialized read-only at the same \/skills\/<name>\/ paths/u);
  assert.match(staged, /run bundled skill scripts directly/u);
  assert.match(staged, /Never include \/workfiles or \/kb in an execute command/u);
  assert.match(staged, /Never write to \/skills from execute commands/u);
  assert.match(staged, /Skill bundles are already staged under \/skills/u);
  // The staged prompt must not carry the unstaged prohibitions.
  assert.doesNotMatch(
    staged,
    /Never include \/workfiles, \/kb, or \/skills in an execute command/u,
  );
  assert.doesNotMatch(staged, /\/kb and \/skills are not prepared directly/u);

  // Unstaged (default): byte-identical to the pre-staging prompt.
  const unstaged = buildSandboxRuntimePrompt(capabilities);
  assert.equal(
    unstaged,
    buildSandboxRuntimePrompt({ ...capabilities, skillScriptsStaged: false }),
  );
  assert.match(
    unstaged,
    /Never include \/workfiles, \/kb, or \/skills in an execute command/u,
  );
  assert.doesNotMatch(unstaged, /run bundled skill scripts directly/u);
});

test("sandbox runtime prompt includes default environment only when enabled", () => {
  const unknownPrompt = buildSandboxRuntimePrompt({
    prepareToolAvailable: true,
    executeAvailable: true,
    collectToolAvailable: true,
  });
  assert.doesNotMatch(unknownPrompt, /<sandbox_environment>/u);
  assert.doesNotMatch(unknownPrompt, /npm install pptxgenjs/u);
  assert.match(unknownPrompt, /binary outputs such as \.pptx, \.pdf, \.zip, or \.xlsx files/u);
  assert.match(unknownPrompt, /artifactType=slides for PPTX decks or artifactType=file/u);

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
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(TEST_LIMITS),
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
    trustedHost: {
      async uploadCurrentFiles() {},
      async downloadCurrentFile() {
        return Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
      },
    },
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
        type: "tool_call" as const,
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
      "SANDBOX_BINARY_OUTPUT_UNSUPPORTED: /workspace/ppt-deck/output/feynman-method.pptx appears to be binary. Use publish_artifact with artifactType=slides for PPTX decks or artifactType=file for generic downloadable files.",
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

test("prepare_sandbox_workspace returns a recoverable error instead of throwing", async () => {
  const operationStore = createOperationStore();
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
    async uploadFile() {
      throw new Error("should not upload missing source");
    },
    async ensureDirectory() {
      throw new Error("should not create directory for missing source");
    },
    async downloadFile() {
      return Buffer.from("");
    },
  };
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore,
    ttlSeconds: TEST_LIMITS.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(TEST_LIMITS),
  });
  const tools = createSandboxTools({
    filesystem: {
      readRaw: async () => ({ error: "ENOENT: no such file" }),
    } as never,
    manager,
    context: TEST_CONTEXT,
    limits: TEST_LIMITS,
    trustedHost: {
      async uploadCurrentFiles() {
        throw new Error("should not upload missing source");
      },
      async downloadCurrentFile() {
        return Buffer.from("");
      },
    },
  });
  const prepareTool = tools.find(
    (candidate) => candidate.name === "prepare_sandbox_workspace",
  );
  assert.ok(prepareTool);

  const toolOutput = await prepareTool.invoke(
    {
      files: [
        {
          sourcePath: "/workfiles/ppt-deck/missing.js",
          sandboxPath: "/workspace/input/missing.js",
        },
      ],
    },
    {
      toolCall: {
        id: "prepare-call-1",
        type: "tool_call" as const,
        name: "prepare_sandbox_workspace",
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
    type: "sandbox_prepare_error",
    status: "failed",
    code: "ENOENT",
    message: "ENOENT: no such file",
    recoverable: true,
  });
  assert.deepEqual(operationStore.completed, [
    {
      status: "succeeded",
      result: output,
    },
  ]);
});

test("prepare_sandbox_workspace forwards Stop through the Host side channel and waits for sandbox deletion", async () => {
  const operationStore = createOperationStore();
  const uploadStarted = deferred<void>();
  const lateUpload = deferred<void>();
  const deletionStarted = deferred<void>();
  const deletionConfirmed = deferred<void>();
  const provider: SandboxProvider = {
    id: "fake",
    pathPolicy: TEST_SANDBOX_PATH_POLICY,
    async createSandbox() {
      return { id: "provider-sandbox-1" };
    },
    async getSandbox() {
      return {};
    },
    async deleteSandbox() {
      deletionStarted.resolve();
      await deletionConfirmed.promise;
    },
    async execute() {
      return { output: "", exitCode: 0, truncated: false };
    },
    async executeSystem(input) {
      if (input.command.includes("SOURCEWEFT_CANONICAL_PATH=")) {
        return {
          output:
            "SOURCEWEFT_CANONICAL_PATH=/workspace/input/presentation.js\n",
          exitCode: 0,
          truncated: false,
        };
      }
      return { output: "", exitCode: 0, truncated: false };
    },
    async uploadFile() {
      uploadStarted.resolve();
      await lateUpload.promise;
    },
    async ensureDirectory() {},
    async downloadFile() {
      return Buffer.from("");
    },
  };
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore,
    ttlSeconds: TEST_LIMITS.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(TEST_LIMITS),
  });
  const trustedHost = createTrustedSandboxHostAdapter({
    manager,
    context: TEST_CONTEXT,
    limits: TEST_LIMITS,
    commandTimeoutMs: TEST_LIMITS.commandBudgetsMs.interactive,
  });
  const tools = createSandboxTools({
    filesystem: {
      readRaw: async () => ({
        data: {
          content: "console.log('ready')",
          mimeType: "application/javascript",
          created_at: "",
          modified_at: "",
        },
      }),
    } as never,
    manager,
    context: TEST_CONTEXT,
    limits: TEST_LIMITS,
    trustedHost,
  });
  const prepareTool = tools.find(
    (candidate) => candidate.name === "prepare_sandbox_workspace",
  );
  assert.ok(prepareTool);
  const stop = new AbortController();
  const config = withAgentToolHostInvocationSignal(
    {
      toolCall: {
        id: "prepare-stop-call",
        type: "tool_call" as const,
        name: "prepare_sandbox_workspace",
        args: {},
      },
    },
    stop.signal,
  );
  const invocation = prepareTool.invoke(
    {
      files: [
        {
          sourcePath: "/workfiles/presentation.js",
          sandboxPath: "/workspace/input/presentation.js",
        },
      ],
    },
    config,
  );
  void invocation.catch(() => undefined);

  await uploadStarted.promise;
  stop.abort(new DOMException("user stopped", "AbortError"));
  await deletionStarted.promise;
  let settled = false;
  void invocation.finally(() => {
    settled = true;
  }).catch(() => undefined);
  await Promise.resolve();
  assert.equal(settled, false);

  deletionConfirmed.resolve();
  await assert.rejects(invocation, (error: unknown) => {
    assert.equal(
      (error as { code?: unknown }).code,
      "SANDBOX_HOST_OPERATION_CANCELLED",
    );
    return true;
  });
  assert.equal(operationStore.completed.at(-1)?.status, "failed");
  assert.equal(
    operationStore.completed.at(-1)?.result?.errorCode,
    "SANDBOX_HOST_OPERATION_CANCELLED",
  );

  lateUpload.resolve();
  await Promise.resolve();
  assert.equal(
    operationStore.completed.some((operation) => operation.status === "succeeded"),
    false,
  );
});

test("collect_sandbox_outputs forwards Host timeout and never persists late sandbox bytes", async () => {
  const operationStore = createOperationStore();
  const downloadStarted = deferred<void>();
  const lateDownload = deferred<Buffer>();
  let deleteCalls = 0;
  const writes: string[] = [];
  const outputPath = "/workspace/output/result.txt";
  const provider: SandboxProvider = {
    id: "fake",
    pathPolicy: TEST_SANDBOX_PATH_POLICY,
    async createSandbox() {
      return { id: "provider-sandbox-1" };
    },
    async getSandbox() {
      return {};
    },
    async deleteSandbox() {
      deleteCalls += 1;
    },
    async execute() {
      return { output: "", exitCode: 0, truncated: false };
    },
    async executeSystem(input) {
      if (input.command.includes("SOURCEWEFT_CANONICAL_PATH=")) {
        return {
          output: `SOURCEWEFT_CANONICAL_PATH=${outputPath}\n`,
          exitCode: 0,
          truncated: false,
        };
      }
      if (input.command.includes("SOURCEWEFT_FILE=")) {
        return {
          output: `SOURCEWEFT_FILE=4\t1\t1\t${outputPath}\n`,
          exitCode: 0,
          truncated: false,
        };
      }
      return { output: "", exitCode: 0, truncated: false };
    },
    async uploadFile() {},
    async ensureDirectory() {},
    async downloadFile() {
      downloadStarted.resolve();
      return lateDownload.promise;
    },
  };
  const manager = new SandboxManager({
    provider,
    sandboxStore: createSandboxStore(),
    operationStore,
    ttlSeconds: TEST_LIMITS.ttlSeconds,
    maxCommandTimeoutMs: maxSandboxCommandTimeoutMs(TEST_LIMITS),
  });
  const trustedHost = createTrustedSandboxHostAdapter({
    manager,
    context: TEST_CONTEXT,
    limits: TEST_LIMITS,
    commandTimeoutMs: TEST_LIMITS.commandBudgetsMs.interactive,
  });
  const tools = createSandboxTools({
    filesystem: {
      readRaw: async () => ({ error: "not found" }),
      write: async (path: string) => {
        writes.push(path);
        return { path };
      },
    } as never,
    manager,
    context: TEST_CONTEXT,
    limits: TEST_LIMITS,
    trustedHost,
  });
  const collectTool = tools.find(
    (candidate) => candidate.name === "collect_sandbox_outputs",
  );
  assert.ok(collectTool);
  const deadline = new AbortController();
  const config = withAgentToolHostInvocationSignal(
    {
      toolCall: {
        id: "collect-timeout-call",
        type: "tool_call" as const,
        name: "collect_sandbox_outputs",
        args: {},
      },
    },
    deadline.signal,
  );
  const invocation = collectTool.invoke(
    {
      outputs: [
        {
          sandboxPath: outputPath,
          target: {
            kind: "workfile",
            path: "/workfiles/result.txt",
          },
        },
      ],
    },
    config,
  );
  void invocation.catch(() => undefined);

  await downloadStarted.promise;
  deadline.abort(
    Object.assign(new Error("tool deadline elapsed"), {
      code: "AGENT_TOOL_EXECUTION_TIMEOUT",
      name: "TimeoutError",
    }),
  );

  await assert.rejects(invocation, (error: unknown) => {
    assert.equal(
      (error as { code?: unknown }).code,
      "SANDBOX_HOST_OPERATION_TIMED_OUT",
    );
    return true;
  });
  assert.equal(deleteCalls, 1);
  assert.deepEqual(writes, []);
  assert.equal(operationStore.completed.at(-1)?.status, "failed");

  lateDownload.resolve(Buffer.from("late"));
  await Promise.resolve();
  assert.deepEqual(writes, []);
  assert.equal(
    operationStore.completed.some((operation) => operation.status === "succeeded"),
    false,
  );
});
