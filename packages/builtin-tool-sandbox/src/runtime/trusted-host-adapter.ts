import { randomUUID } from "node:crypto";
import {
  AGENT_TOOL_HOST_LIMITS,
  type AgentToolSandboxServices,
} from "@sourceweft/contracts/agent-tools";
import {
  assertExecuteCommandPathPolicy,
  assertExecuteCwd,
  assertSandboxReadPath,
  assertSandboxWritePath,
  commandReferencesSkillsRoot,
  dirname,
  shellQuote,
} from "./paths";
import { redactSandboxText, sandboxRequestFingerprint } from "./redaction";
import { runPinnedSandboxOperation } from "./pinned-sandbox-operation";
import type { SandboxManager } from "./sandbox-manager";
import type {
  SandboxCancellationReason,
  SandboxCancellationResult,
  SandboxProvider,
  SandboxProviderPathPolicy,
  SandboxRef,
  SandboxRuntimeContext,
  SandboxRuntimeLimits,
} from "./types";

const CANONICAL_PATH_MARKER = "SOURCEWEFT_CANONICAL_PATH=";
const FILE_STAT_MARKER = "SOURCEWEFT_FILE=";
// stat -c prints backslash escapes literally; its field delimiters must be tabs.
const STAT_FIELDS_FORMAT = "%s\t%Y\t%i\t%n";
const MANIFEST_BEGIN = "SOURCEWEFT_MANIFEST_BEGIN";
const MANIFEST_END = "SOURCEWEFT_MANIFEST_END";
const SYMLINK_MARKER = "SOURCEWEFT_SYMLINK=";

type ManifestEntry = {
  path: string;
  size: number;
  modified: string;
  inode: string;
};

/** The concrete, fully-populated side of the generic host contract. */
export type TrustedSandboxHostAdapter = Required<AgentToolSandboxServices>;

export class TrustedSandboxAbortError extends Error {
  readonly code:
    | "SANDBOX_HOST_OPERATION_CANCELLED"
    | "SANDBOX_HOST_OPERATION_TIMED_OUT"
    | "SANDBOX_TERMINATION_UNKNOWN";
  readonly cancellationMode: SandboxCancellationResult["mode"];
  readonly physicalCancellationConfirmed: boolean;

  constructor(input: {
    cancellation: SandboxCancellationResult;
    reason: SandboxCancellationReason;
  }) {
    const code = !input.cancellation.confirmed
      ? "SANDBOX_TERMINATION_UNKNOWN"
      : input.reason === "timed_out"
        ? "SANDBOX_HOST_OPERATION_TIMED_OUT"
        : "SANDBOX_HOST_OPERATION_CANCELLED";
    super(
      input.cancellation.confirmed
        ? `Sandbox ${input.cancellation.mode} termination was confirmed after ${input.reason === "timed_out" ? "timeout" : "cancellation"}.`
        : "Sandbox termination was requested, but the provider could not confirm that the remote execution stopped.",
    );
    this.code = code;
    this.cancellationMode = input.cancellation.mode;
    this.physicalCancellationConfirmed = input.cancellation.confirmed;
    this.name = input.reason === "timed_out" ? "TimeoutError" : "AbortError";
  }
}

export class TrustedSandboxResultDiscardedError extends Error {
  readonly code = "SANDBOX_EXECUTION_RESULT_DISCARDED" as const;

  constructor() {
    super(
      "Sandbox execution result was discarded because its sandbox generation was terminated.",
    );
    this.name = "AbortError";
  }
}

function hasControlChars(value: string) {
  return /[\x00-\x1f\x7f]/u.test(value);
}

function cancellationReason(signal?: AbortSignal): SandboxCancellationReason {
  const reason = signal?.reason;
  const record =
    reason && typeof reason === "object"
      ? (reason as Record<string, unknown>)
      : null;
  const marker = [record?.name, record?.code, record?.message, reason]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return marker.includes("timeout") || marker.includes("timed_out")
    ? "timed_out"
    : "user_cancelled";
}

function isProviderCommandTimeout(error: unknown) {
  return (
    error instanceof Error && error.message.includes("SANDBOX_COMMAND_TIMEOUT")
  );
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new TrustedSandboxAbortError({
      cancellation: { confirmed: true, mode: "command" },
      reason: cancellationReason(signal),
    });
  }
}

function waitForAbort(signal?: AbortSignal, onAbortRequested?: () => void) {
  if (!signal) {
    return {
      promise: new Promise<never>(() => {}),
      dispose() {},
    };
  }
  let abortListener: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    const notify = () => {
      onAbortRequested?.();
      resolve();
    };
    if (signal.aborted) {
      notify();
      return;
    }
    abortListener = notify;
    signal.addEventListener("abort", abortListener, { once: true });
  });
  return {
    promise,
    dispose() {
      if (abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    },
  };
}

function providerExecuteSystem(provider: SandboxProvider) {
  return provider.executeSystem
    ? provider.executeSystem.bind(provider)
    : provider.execute.bind(provider);
}

function effectiveMaxOutputChars(limits: SandboxRuntimeLimits) {
  return Math.min(
    limits.maxOutputChars,
    AGENT_TOOL_HOST_LIMITS.sandboxCommandMaxOutputChars,
  );
}

function isRootOrChild(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`);
}

function manifestSignature(entries: readonly ManifestEntry[]) {
  return entries
    .map((entry) =>
      [entry.path, entry.size, entry.modified, entry.inode].join("\0"),
    )
    .join("\n");
}

function parseManifest(input: {
  output: string;
  root: string;
  policy: SandboxProviderPathPolicy;
}) {
  const lines = input.output.split(/\r?\n/u).filter(Boolean);
  const symlink = lines.find((line) => line.startsWith(SYMLINK_MARKER));
  if (symlink) {
    throw new Error(
      `SANDBOX_HOST_SYMLINK_DENIED: ${symlink.slice(SYMLINK_MARKER.length)}`,
    );
  }
  const begin = lines.indexOf(MANIFEST_BEGIN);
  const end = lines.indexOf(MANIFEST_END);
  if (begin < 0 || end <= begin) {
    throw new Error(
      "SANDBOX_HOST_MANIFEST_INVALID: sandbox tree manifest is malformed.",
    );
  }
  const entries = lines.slice(begin + 1, end).map((line) => {
    const parts = line.split("\t");
    if (parts.length !== 4) {
      throw new Error(
        "SANDBOX_HOST_MANIFEST_INVALID: sandbox file name contains unsupported control characters.",
      );
    }
    const [sizeText, modified, inode, rawPath] = parts;
    const size = Number(sizeText);
    if (
      !rawPath ||
      !modified ||
      !inode ||
      hasControlChars(rawPath) ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new Error(
        "SANDBOX_HOST_MANIFEST_INVALID: sandbox tree manifest entry is invalid.",
      );
    }
    const path = assertSandboxReadPath(rawPath, input.policy);
    if (!isRootOrChild(path, input.root)) {
      throw new Error(
        "SANDBOX_HOST_MANIFEST_ESCAPE: sandbox tree contains a file outside its canonical root.",
      );
    }
    return { path, size, modified, inode };
  });
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function parseFileStat(input: {
  output: string;
  expectedPath: string;
  policy: SandboxProviderPathPolicy;
}) {
  const line = input.output
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(FILE_STAT_MARKER));
  const parts = line?.slice(FILE_STAT_MARKER.length).split("\t") ?? [];
  if (parts.length !== 4) {
    throw new Error(
      "SANDBOX_HOST_FILE_STAT_INVALID: sandbox file stat is malformed.",
    );
  }
  const [sizeText, modified, inode, rawPath] = parts;
  const size = Number(sizeText);
  const path = rawPath ? assertSandboxReadPath(rawPath, input.policy) : "";
  if (
    path !== input.expectedPath ||
    !modified ||
    !inode ||
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    throw new Error(
      "SANDBOX_HOST_FILE_STAT_INVALID: sandbox file stat identity is invalid.",
    );
  }
  return { path, size, modified, inode };
}

export function createTrustedSandboxHostAdapter(input: {
  manager: SandboxManager;
  context: SandboxRuntimeContext;
  limits: SandboxRuntimeLimits;
  commandTimeoutMs: number;
}): TrustedSandboxHostAdapter {
  const policy = input.manager.providerForSandbox().pathPolicy;
  const maxOutputChars = effectiveMaxOutputChars(input.limits);
  const maxCaptureFiles = AGENT_TOOL_HOST_LIMITS.sandboxCaptureMaxFiles;
  const maxCaptureTotalBytes = Math.min(
    input.limits.maxCollectTotalBytes,
    AGENT_TOOL_HOST_LIMITS.sandboxCaptureMaxTotalBytes,
  );
  const maxDownloadBytes = Math.min(
    input.limits.maxCollectFileBytes,
    AGENT_TOOL_HOST_LIMITS.sandboxCaptureMaxTotalBytes,
  );
  const maxUploadFileBytes = Math.min(
    input.limits.maxPrepareFileBytes,
    AGENT_TOOL_HOST_LIMITS.sandboxCaptureMaxTotalBytes,
  );
  const maxUploadTotalBytes = Math.min(
    input.limits.maxPrepareTotalBytes,
    AGENT_TOOL_HOST_LIMITS.sandboxCaptureMaxTotalBytes,
  );

  const session = async () => {
    const sandbox = await input.manager.getOrCreateThreadSandbox(input.context);
    return {
      sandbox,
      provider: input.manager.providerForSandbox(),
    };
  };

  type CurrentSession = {
    sandbox: SandboxRef;
    provider: SandboxProvider;
  };
  type SystemRunOptions = {
    current?: CurrentSession;
    executionId?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  };

  const runSystem = async (command: string, options: SystemRunOptions = {}) => {
    const current = options.current ?? (await session());
    return providerExecuteSystem(current.provider)({
      providerSandboxId: current.sandbox.providerSandboxId,
      ...(options.executionId ? { executionId: options.executionId } : {}),
      command,
      cwd: assertExecuteCwd(undefined, current.provider.pathPolicy),
      timeoutMs: Math.min(
        options.timeoutMs ?? input.commandTimeoutMs,
        input.commandTimeoutMs,
        30_000,
      ),
      maxOutputChars,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  };

  const canonicalPath = async (
    value: string,
    mode: "read" | "write",
    options: SystemRunOptions = {},
  ) => {
    const lexical =
      mode === "read"
        ? assertSandboxReadPath(value, policy)
        : assertSandboxWritePath(value, policy);
    const result = await runSystem(
      [
        "set -eu",
        `target=${shellQuote(lexical)}`,
        'resolved=$(realpath -m -- "$target")',
        `printf '${CANONICAL_PATH_MARKER}%s\\n' "$resolved"`,
      ].join("; "),
      options,
    );
    if (result.exitCode !== 0 || result.truncated) {
      throw new Error(
        "SANDBOX_HOST_CANONICAL_PATH_FAILED: sandbox path could not be canonicalized.",
      );
    }
    const line = result.output
      .split(/\r?\n/u)
      .find((candidate) => candidate.startsWith(CANONICAL_PATH_MARKER));
    const resolved = line?.slice(CANONICAL_PATH_MARKER.length);
    if (!resolved || hasControlChars(resolved)) {
      throw new Error(
        "SANDBOX_HOST_CANONICAL_PATH_FAILED: sandbox returned an invalid canonical path.",
      );
    }
    try {
      return mode === "read"
        ? assertSandboxReadPath(resolved, policy)
        : assertSandboxWritePath(resolved, policy);
    } catch {
      throw new Error(
        `SANDBOX_HOST_SYMLINK_ESCAPE: ${lexical} resolves outside allowed sandbox roots.`,
      );
    }
  };

  const readManifest = async (manifestInput: {
    root: string;
    maxFiles: number;
    maxTotalBytes: number;
    options?: SystemRunOptions;
  }) => {
    const root = await canonicalPath(
      manifestInput.root,
      "read",
      manifestInput.options,
    );
    const result = await runSystem(
      [
        "set -eu",
        `root=${shellQuote(root)}`,
        '[ -d "$root" ]',
        'link=$(find -P "$root" -type l -print -quit)',
        `if [ -n "$link" ]; then printf '${SYMLINK_MARKER}%s\\n' "$link"; exit 73; fi`,
        `printf '${MANIFEST_BEGIN}\\n'`,
        `find -P "$root" -type f -exec stat -c '${STAT_FIELDS_FORMAT}' -- {} \\;`,
        `printf '${MANIFEST_END}\\n'`,
      ].join("; "),
      manifestInput.options,
    );
    if (result.exitCode === 73 || result.output.includes(SYMLINK_MARKER)) {
      const link = result.output
        .split(/\r?\n/u)
        .find((line) => line.startsWith(SYMLINK_MARKER));
      throw new Error(
        `SANDBOX_HOST_SYMLINK_DENIED: ${link?.slice(SYMLINK_MARKER.length) ?? root}`,
      );
    }
    if (result.exitCode !== 0 || result.truncated) {
      throw new Error(
        "SANDBOX_HOST_TREE_LIST_FAILED: sandbox tree could not be listed within output limits.",
      );
    }
    const entries = parseManifest({ output: result.output, root, policy });
    if (entries.length > manifestInput.maxFiles) {
      throw new Error(
        `SANDBOX_HOST_CAPTURE_FILE_LIMIT: tree contains more than ${manifestInput.maxFiles} files.`,
      );
    }
    let totalBytes = 0;
    for (const entry of entries) {
      if (entry.size > maxDownloadBytes) {
        throw new Error(
          `SANDBOX_HOST_CAPTURE_FILE_TOO_LARGE: ${entry.path} exceeds the ${maxDownloadBytes} byte limit.`,
        );
      }
      totalBytes += entry.size;
      if (totalBytes > manifestInput.maxTotalBytes) {
        throw new Error(
          `SANDBOX_HOST_CAPTURE_TOTAL_LIMIT: tree exceeds the ${manifestInput.maxTotalBytes} byte limit.`,
        );
      }
    }
    return { root, entries };
  };

  const statFile = async (
    sandboxPath: string,
    options: SystemRunOptions = {},
  ) => {
    const path = await canonicalPath(sandboxPath, "read", options);
    const result = await runSystem(
      [
        "set -eu",
        `target=${shellQuote(path)}`,
        '[ -f "$target" ]',
        `[ ! -L "$target" ]`,
        `stat -c '${FILE_STAT_MARKER}${STAT_FIELDS_FORMAT}' -- "$target"`,
      ].join("; "),
      options,
    );
    if (result.exitCode !== 0 || result.truncated) {
      throw new Error(
        `SANDBOX_HOST_FILE_STAT_FAILED: ${path} is not a readable regular file.`,
      );
    }
    return parseFileStat({ output: result.output, expectedPath: path, policy });
  };

  const operationTimeoutMs = (value: number | undefined, code: string) => {
    const requested = value ?? input.commandTimeoutMs;
    if (
      !Number.isSafeInteger(requested) ||
      requested <= 0 ||
      requested > AGENT_TOOL_HOST_LIMITS.sandboxCommandMaxTimeoutMs
    ) {
      throw new Error(`${code}: timeout exceeds host limits.`);
    }
    return Math.min(
      requested,
      input.commandTimeoutMs,
      input.limits.maxCommandTimeoutMs,
    );
  };

  const assertPinnedGeneration = async (current: CurrentSession) => {
    const disposition = await input.manager.resolveExecutionResultDisposition(
      current.sandbox,
      input.context,
    );
    if (disposition === "termination_unknown") {
      throw new TrustedSandboxAbortError({
        cancellation: { confirmed: false, mode: "unknown" },
        reason: "user_cancelled",
      });
    }
    if (disposition === "sandbox_terminated") {
      throw new TrustedSandboxResultDiscardedError();
    }
  };

  /**
   * Run a host-only file operation against one pinned sandbox generation.
   * File APIs have no command handle, so abort/timeout always deletes the whole
   * sandbox and waits for that physical result before this promise settles.
   */
  const runPinnedFileOperation = async <T>(operationInput: {
    code: string;
    current: CurrentSession;
    signal?: AbortSignal;
    timeoutMs?: number;
    operation: (
      options: Required<
        Pick<
          SystemRunOptions,
          "current" | "executionId" | "signal" | "timeoutMs"
        >
      >,
    ) => Promise<T>;
  }) => {
    const timeoutMs = operationTimeoutMs(
      operationInput.timeoutMs,
      operationInput.code,
    );
    return runPinnedSandboxOperation({
      manager: input.manager,
      context: input.context,
      sandbox: operationInput.current.sandbox,
      signal: operationInput.signal,
      timeoutMs,
      timeoutMessage: "Sandbox file operation timed out.",
      invalidStateMessage:
        "SANDBOX_HOST_CANCELLATION_STATE_INVALID: aborted file operation reached the success path.",
      createAbortError: (abortInput) =>
        new TrustedSandboxAbortError(abortInput),
      createDiscardedError: () => new TrustedSandboxResultDiscardedError(),
      operation: (options) =>
        operationInput.operation({
          current: operationInput.current,
          ...options,
        }),
    });
  };

  const downloadVerified = async (downloadInput: {
    sandboxPath: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => {
    const requestedTimeoutMs =
      downloadInput.timeoutMs ?? input.commandTimeoutMs;
    if (
      !Number.isSafeInteger(requestedTimeoutMs) ||
      requestedTimeoutMs <= 0 ||
      requestedTimeoutMs > AGENT_TOOL_HOST_LIMITS.sandboxCommandMaxTimeoutMs
    ) {
      throw new Error(
        "SANDBOX_HOST_DOWNLOAD_TIMEOUT_INVALID: timeout exceeds host limits.",
      );
    }
    throwIfAborted(downloadInput.signal);
    const current = await session();
    throwIfAborted(downloadInput.signal);
    const timeoutMs = Math.min(
      requestedTimeoutMs,
      input.commandTimeoutMs,
      input.limits.maxCommandTimeoutMs,
    );
    const executionId = randomUUID();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(downloadInput.signal?.reason);
    if (downloadInput.signal?.aborted) {
      forwardAbort();
    } else {
      downloadInput.signal?.addEventListener("abort", forwardAbort, {
        once: true,
      });
    }
    const timeoutHandle = setTimeout(
      () =>
        controller.abort(
          new DOMException("Sandbox download timed out.", "TimeoutError"),
        ),
      timeoutMs,
    );
    timeoutHandle.unref?.();
    let cancellationRun: Promise<SandboxCancellationResult> | undefined;
    const beginCancellation = () => {
      cancellationRun ??= input.manager.cancelExecution({
        sandbox: current.sandbox,
        executionId,
        reason: cancellationReason(controller.signal),
        forceSandbox: true,
      });
    };
    const abortWait = waitForAbort(controller.signal, beginCancellation);
    const operation = (async () => {
      const systemOptions: SystemRunOptions = {
        current,
        executionId,
        signal: controller.signal,
        timeoutMs,
      };
      const before = await statFile(downloadInput.sandboxPath, systemOptions);
      if (before.size > maxDownloadBytes) {
        throw new Error(
          `SANDBOX_HOST_DOWNLOAD_TOO_LARGE: ${before.path} exceeds the ${maxDownloadBytes} byte limit.`,
        );
      }
      const bytes = await current.provider.downloadFile({
        providerSandboxId: current.sandbox.providerSandboxId,
        executionId,
        sandboxPath: before.path,
        signal: controller.signal,
        timeoutMs,
      });
      const after = await statFile(before.path, systemOptions);
      if (
        before.size !== bytes.byteLength ||
        manifestSignature([before]) !== manifestSignature([after])
      ) {
        throw new Error(
          `SANDBOX_HOST_FILE_CHANGED: ${before.path} changed while it was read.`,
        );
      }
      return new Uint8Array(bytes);
    })().then(
      (result) => ({ kind: "result" as const, result }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    try {
      const outcome = await Promise.race([
        operation,
        abortWait.promise.then(() => ({ kind: "aborted" as const })),
      ]);
      const reason: SandboxCancellationReason | null =
        outcome.kind === "aborted" ||
        (outcome.kind === "error" && controller.signal.aborted)
          ? cancellationReason(controller.signal)
          : outcome.kind === "error" && isProviderCommandTimeout(outcome.error)
            ? "timed_out"
            : null;
      if (reason) {
        const cancellation = await (cancellationRun ??
          input.manager.cancelExecution({
            sandbox: current.sandbox,
            executionId,
            reason,
            forceSandbox: true,
          }));
        throw new TrustedSandboxAbortError({ cancellation, reason });
      }
      if (outcome.kind === "error") throw outcome.error;
      if (outcome.kind !== "result") {
        throw new Error(
          "SANDBOX_HOST_CANCELLATION_STATE_INVALID: aborted download reached the success path.",
        );
      }
      const disposition = await input.manager.resolveExecutionResultDisposition(
        current.sandbox,
        input.context,
      );
      if (disposition === "termination_unknown") {
        throw new TrustedSandboxAbortError({
          cancellation: { confirmed: false, mode: "unknown" },
          reason: "user_cancelled",
        });
      }
      if (disposition === "sandbox_terminated") {
        throw new TrustedSandboxResultDiscardedError();
      }
      return outcome.result;
    } finally {
      clearTimeout(timeoutHandle);
      abortWait.dispose();
      downloadInput.signal?.removeEventListener("abort", forwardAbort);
    }
  };

  return {
    allowedReadRoots: [...policy.readWriteRoots],

    async ensureCurrentSession() {
      const current = await session();
      const runtimeAssets = Object.fromEntries(
        (input.manager.requiredAssetResolutions() ?? [])
          .filter(
            (resolution) => resolution.ok && Boolean(resolution.entrypointPath),
          )
          .map((resolution) => [resolution.name, resolution.entrypointPath!]),
      );
      return {
        sessionGeneration: current.sandbox.id,
        hostLimits: {
          commandTimeoutMs: input.commandTimeoutMs,
          maxOutputChars,
          maxUploadFileBytes,
          maxUploadTotalBytes,
          maxDownloadFileBytes: maxDownloadBytes,
          maxDownloadTotalBytes: maxCaptureTotalBytes,
          maxCaptureFiles,
        },
        ...(Object.keys(runtimeAssets).length > 0 ? { runtimeAssets } : {}),
      };
    },

    async uploadCurrentFiles(files, options) {
      if (files.length > maxCaptureFiles) {
        throw new Error(
          `SANDBOX_HOST_UPLOAD_FILE_LIMIT: upload contains more than ${maxCaptureFiles} files.`,
        );
      }
      let totalBytes = 0;
      for (const file of files) {
        if (!(file.bytes instanceof Uint8Array)) {
          throw new Error(
            "SANDBOX_HOST_UPLOAD_BYTES_INVALID: upload bytes must be Uint8Array values.",
          );
        }
        assertSandboxWritePath(file.path, policy);
        if (file.bytes.byteLength > maxUploadFileBytes) {
          throw new Error(
            `SANDBOX_HOST_UPLOAD_FILE_TOO_LARGE: ${file.path} exceeds the ${maxUploadFileBytes} byte limit.`,
          );
        }
        totalBytes += file.bytes.byteLength;
        if (totalBytes > maxUploadTotalBytes) {
          throw new Error(
            `SANDBOX_HOST_UPLOAD_TOTAL_LIMIT: upload exceeds the ${maxUploadTotalBytes} byte limit.`,
          );
        }
      }
      const current = await session();
      await runPinnedFileOperation({
        code: "SANDBOX_HOST_UPLOAD_TIMEOUT_INVALID",
        current,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
        operation: async (systemOptions) => {
          await assertPinnedGeneration(current);
          const canonicalFiles = await Promise.all(
            files.map(async (file) => ({
              path: await canonicalPath(file.path, "write", systemOptions),
              bytes: file.bytes,
            })),
          );
          await assertPinnedGeneration(current);
          if (
            new Set(canonicalFiles.map((file) => file.path)).size !==
            files.length
          ) {
            throw new Error(
              "SANDBOX_HOST_UPLOAD_PATH_CONFLICT: upload paths resolve to the same canonical target.",
            );
          }
          const directories = new Set(
            canonicalFiles.map((file) => dirname(file.path)),
          );
          for (const directory of directories) {
            throwIfAborted(systemOptions.signal);
            await assertPinnedGeneration(current);
            await current.provider.ensureDirectory({
              providerSandboxId: current.sandbox.providerSandboxId,
              directory,
            });
            await assertPinnedGeneration(current);
          }
          for (const file of canonicalFiles) {
            throwIfAborted(systemOptions.signal);
            const checkedPath = await canonicalPath(
              file.path,
              "write",
              systemOptions,
            );
            await assertPinnedGeneration(current);
            if (checkedPath !== file.path) {
              throw new Error(
                `SANDBOX_HOST_UPLOAD_PATH_CHANGED: ${file.path} changed after directory preparation.`,
              );
            }
            await current.provider.uploadFile({
              providerSandboxId: current.sandbox.providerSandboxId,
              sandboxPath: file.path,
              content: file.bytes,
            });
            await assertPinnedGeneration(current);
          }
        },
      });
    },

    async listCurrentFiles(listInput) {
      const current = await session();
      await assertPinnedGeneration(current);
      const manifest = await readManifest({
        root: listInput.root,
        maxFiles: maxCaptureFiles,
        maxTotalBytes: maxCaptureTotalBytes,
        options: { current },
      });
      await assertPinnedGeneration(current);
      return manifest.entries.map((entry) => entry.path);
    },

    downloadCurrentFile(downloadInput) {
      return downloadVerified(downloadInput);
    },

    async executeCurrent(executeInput) {
      if (
        !Number.isSafeInteger(executeInput.timeoutMs) ||
        executeInput.timeoutMs <= 0 ||
        executeInput.timeoutMs >
          AGENT_TOOL_HOST_LIMITS.sandboxCommandMaxTimeoutMs
      ) {
        throw new Error(
          "SANDBOX_HOST_EXECUTE_TIMEOUT_INVALID: timeout exceeds host limits.",
        );
      }
      throwIfAborted(executeInput.signal);
      const skillsDeferred =
        commandReferencesSkillsRoot(executeInput.command) &&
        input.manager.skillStagingConfigured();
      assertExecuteCommandPathPolicy(executeInput.command, {
        skillScriptsStaged: skillsDeferred,
      });
      const current = await session();
      if (skillsDeferred && !input.manager.skillScriptsStaged()) {
        throw new Error(
          "SANDBOX_SKILL_STAGING_UNAVAILABLE: staged skill scripts are unavailable.",
        );
      }
      throwIfAborted(executeInput.signal);
      const timeoutMs = Math.min(
        executeInput.timeoutMs,
        input.commandTimeoutMs,
        input.limits.maxCommandTimeoutMs,
      );
      const executionId = randomUUID();
      const startedAt = Date.now();
      const request = {
        command: executeInput.command,
        commandFingerprint: sandboxRequestFingerprint({
          command: executeInput.command,
        }),
        requestedTimeoutMs: executeInput.timeoutMs,
        timeoutMs,
        executionId,
      };
      let cancellationRun: Promise<SandboxCancellationResult> | undefined;
      const beginCancellation = () => {
        cancellationRun ??= input.manager.cancelExecution({
          sandbox: current.sandbox,
          executionId,
          reason: cancellationReason(executeInput.signal),
        });
      };
      const abortWait = waitForAbort(executeInput.signal, beginCancellation);
      const execution = providerExecuteSystem(current.provider)({
        providerSandboxId: current.sandbox.providerSandboxId,
        executionId,
        command: executeInput.command,
        cwd: assertExecuteCwd(undefined, current.provider.pathPolicy),
        timeoutMs,
        maxOutputChars,
        ...(executeInput.signal ? { signal: executeInput.signal } : {}),
      }).then(
        (result) => ({ kind: "result" as const, result }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      try {
        const outcome = await Promise.race([
          execution,
          abortWait.promise.then(() => ({ kind: "aborted" as const })),
        ]);
        const reason: SandboxCancellationReason | null =
          outcome.kind === "aborted" ||
          (outcome.kind === "error" && executeInput.signal?.aborted)
            ? cancellationReason(executeInput.signal)
            : outcome.kind === "error" &&
                isProviderCommandTimeout(outcome.error)
              ? "timed_out"
              : null;
        if (reason) {
          let cancellation: SandboxCancellationResult;
          try {
            cancellation = await (cancellationRun ??
              input.manager.cancelExecution({
                sandbox: current.sandbox,
                executionId,
                reason,
              }));
          } catch {
            cancellation = { confirmed: false, mode: "unknown" };
          }
          const error = new TrustedSandboxAbortError({
            cancellation,
            reason,
          });
          await input.manager.recordOperation({
            context: input.context,
            sandboxId: current.sandbox.id,
            operationType: "execute",
            status: "canceled",
            request,
            result: {
              errorCode: error.code,
              executionId,
              cancellationRequested: true,
              cancellationMode: error.cancellationMode,
              resultDiscarded: true,
              physicalCancellationConfirmed:
                error.physicalCancellationConfirmed,
            },
            durationMs: Date.now() - startedAt,
          });
          throw error;
        }
        if (outcome.kind !== "result") {
          throw outcome.kind === "error"
            ? outcome.error
            : new Error(
                "SANDBOX_HOST_CANCELLATION_STATE_INVALID: aborted execution reached the success path.",
              );
        }
        const result = outcome.result;
        const disposition =
          await input.manager.resolveExecutionResultDisposition(
            current.sandbox,
            input.context,
          );
        if (disposition !== "accepted") {
          const error =
            disposition === "termination_unknown"
              ? new TrustedSandboxAbortError({
                  cancellation: { confirmed: false, mode: "unknown" },
                  reason: "user_cancelled",
                })
              : new TrustedSandboxResultDiscardedError();
          await input.manager.recordOperation({
            context: input.context,
            sandboxId: current.sandbox.id,
            operationType: "execute",
            status: "canceled",
            request,
            result: {
              errorCode: error.code,
              executionId,
              resultDiscarded: true,
            },
            durationMs: Date.now() - startedAt,
          });
          throw error;
        }
        const normalized = {
          output: redactSandboxText(result.output),
          exitCode: result.exitCode,
          truncated: result.truncated === true,
        };
        await input.manager.recordOperation({
          context: input.context,
          sandboxId: current.sandbox.id,
          operationType: "execute",
          status: "succeeded",
          request,
          result: {
            exitCode: normalized.exitCode,
            truncated: normalized.truncated,
            outputChars: normalized.output.length,
          },
          durationMs: Date.now() - startedAt,
        });
        return normalized;
      } catch (error) {
        if (
          error instanceof TrustedSandboxAbortError ||
          error instanceof TrustedSandboxResultDiscardedError
        ) {
          throw error;
        }
        await input.manager.recordOperation({
          context: input.context,
          sandboxId: current.sandbox.id,
          operationType: "execute",
          status: "failed",
          request,
          result: {
            error: redactSandboxText(
              error instanceof Error ? error.message : String(error),
            ),
          },
          durationMs: Date.now() - startedAt,
        });
        throw error;
      } finally {
        abortWait.dispose();
      }
    },

    async captureCurrentTree(captureInput) {
      if (
        !Number.isSafeInteger(captureInput.maxFiles) ||
        captureInput.maxFiles <= 0 ||
        captureInput.maxFiles > maxCaptureFiles ||
        !Number.isSafeInteger(captureInput.maxTotalBytes) ||
        captureInput.maxTotalBytes <= 0 ||
        captureInput.maxTotalBytes > maxCaptureTotalBytes
      ) {
        throw new Error(
          "SANDBOX_HOST_CAPTURE_LIMIT_INVALID: requested capture limits exceed host ceilings.",
        );
      }
      const current = await session();
      return runPinnedFileOperation({
        code: "SANDBOX_HOST_CAPTURE_TIMEOUT_INVALID",
        current,
        signal: captureInput.signal,
        timeoutMs: captureInput.timeoutMs,
        operation: async (systemOptions) => {
          await assertPinnedGeneration(current);
          const before = await readManifest({
            root: captureInput.root,
            maxFiles: captureInput.maxFiles,
            maxTotalBytes: captureInput.maxTotalBytes,
            options: systemOptions,
          });
          await assertPinnedGeneration(current);
          const captured: Array<{
            relativePath: string;
            bytes: Uint8Array;
          }> = [];
          for (const entry of before.entries) {
            throwIfAborted(systemOptions.signal);
            await assertPinnedGeneration(current);
            const bytes = await current.provider.downloadFile({
              providerSandboxId: current.sandbox.providerSandboxId,
              executionId: systemOptions.executionId,
              sandboxPath: entry.path,
              signal: systemOptions.signal,
              timeoutMs: systemOptions.timeoutMs,
            });
            await assertPinnedGeneration(current);
            if (bytes.byteLength !== entry.size) {
              throw new Error(
                `SANDBOX_HOST_TREE_CHANGED: ${entry.path} changed while it was captured.`,
              );
            }
            captured.push({
              relativePath: entry.path.slice(before.root.length + 1),
              bytes: new Uint8Array(bytes),
            });
          }
          const after = await readManifest({
            root: before.root,
            maxFiles: captureInput.maxFiles,
            maxTotalBytes: captureInput.maxTotalBytes,
            options: systemOptions,
          });
          await assertPinnedGeneration(current);
          if (
            manifestSignature(before.entries) !==
            manifestSignature(after.entries)
          ) {
            throw new Error(
              "SANDBOX_HOST_TREE_CHANGED: sandbox tree changed while it was captured.",
            );
          }
          return captured;
        },
      });
    },
  };
}
