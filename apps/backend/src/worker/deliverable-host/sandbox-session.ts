import type {
  DeliverableJobEnvelope,
  DeliverableRuntimeAssetResolution,
  DeliverableSandboxSession,
} from "@sourceweft/capability-contracts";
import {
  ensureRuntimeAssets,
  type RuntimeAssetPlan,
} from "@sourceweft/builtin-tool-sandbox";
import { findSandboxAssetSpec } from "../../shared/sandbox-assets/catalog";
import {
  loadSandboxAssetContent,
  presignSandboxAssetUrl,
} from "../../shared/sandbox-assets/cache";
import { logger } from "../../shared/logger";

/**
 * Sandbox adapter for deliverable pipelines: exposes the narrow session
 * primitives (upload/execute/download + rootDir) that pipeline packages
 * program against. The agent sandbox service is injected at construction —
 * pipelines never import backend singletons (DESIGN_REVIEW 2.2.1).
 */

type AgentSandboxServiceLike = {
  createRuntimeForTurn(input: {
    filesystem: never;
    context: {
      teamId: string;
      workspaceId: string;
      threadId: string;
      userId: string;
      messageId: string;
      runId: string;
      sandboxExecuteToolCallId?: string;
    };
    commandBudget?: "interactive" | "batch";
  }): Promise<{
    pathPolicy: { defaultCwd: string };
    backend: {
      uploadFiles(
        files: Array<[string, Uint8Array]>,
      ): Promise<Array<{ path: string; error?: string | null }>>;
      execute(
        command: string,
        options?: { toolCallId?: string | null },
      ): Promise<{ exitCode: number | null; output: string; truncated?: boolean }>;
      downloadFiles(
        paths: string[],
      ): Promise<
        Array<{ path: string; content: Uint8Array | null; error?: string | null }>
      >;
    };
  } | null>;
};

function createEmptySandboxFilesystemBackend() {
  const readOnlyError = {
    error:
      "No SourceWeft VFS is mounted for deliverable worker sandbox execution.",
  };
  return {
    async ls() {
      return { files: [] };
    },
    async read() {
      return readOnlyError;
    },
    async readRaw() {
      return readOnlyError;
    },
    async grep() {
      return { matches: [] };
    },
    async glob() {
      return { files: [] };
    },
    async write() {
      return readOnlyError;
    },
    async edit() {
      return readOnlyError;
    },
  };
}

export function createDeliverableSandboxAdapter(input: {
  sandboxService: AgentSandboxServiceLike;
}) {
  return {
    createSession: async (sessionInput: {
      job: DeliverableJobEnvelope;
    }): Promise<DeliverableSandboxSession | null> => {
      const job = sessionInput.job;
      const runtime = await input.sandboxService.createRuntimeForTurn({
        filesystem: createEmptySandboxFilesystemBackend() as never,
        context: {
          teamId: job.teamId,
          workspaceId: job.workspaceId,
          threadId: job.threadId,
          userId: job.userId,
          messageId: job.userMessageId,
          runId: job.traceId ?? job.jobId,
          sandboxExecuteToolCallId: job.toolCallId,
        },
        // Deliverable stages are host-issued and deterministic — installs, type
        // checks and renders run for minutes with no model in the loop — so
        // they run on the batch command budget rather than the short
        // interactive one. This literal is the *only* thing that grants the
        // longer timeout: pipelines cannot ask for it per command, and neither
        // can the model, whose execute tool input is a command string.
        commandBudget: "batch",
      });
      if (!runtime) {
        return null;
      }
      return {
        rootDir: runtime.pathPolicy.defaultCwd.replace(/\/$/u, ""),
        uploadFiles: (files) => runtime.backend.uploadFiles(files),
        execute: (command, options) =>
          runtime.backend.execute(command, {
            toolCallId: options?.toolCallId,
          }),
        downloadFiles: (paths) => runtime.backend.downloadFiles(paths),
      };
    },

    /**
     * Runtime-asset resolution for deliverable pipelines
     * (docs/architecture/sandbox-runtime-assets.md): catalog names in, ladder
     * outcomes out. Unknown names resolve to a failed entry rather than a
     * throw — the pipeline's contract is best-effort degradation.
     */
    ensureRuntimeAssets: async (input: {
      session: DeliverableSandboxSession;
      assets: readonly string[];
      job?: DeliverableJobEnvelope;
    }): Promise<DeliverableRuntimeAssetResolution[]> => {
      const plans: RuntimeAssetPlan[] = [];
      const unknown: DeliverableRuntimeAssetResolution[] = [];
      for (const name of input.assets) {
        const spec = findSandboxAssetSpec(name);
        if (!spec) {
          unknown.push({
            name,
            version: "unknown",
            ok: false,
            ms: 0,
            error: "asset not in the platform catalog",
          });
          continue;
        }
        plans.push({
          name: spec.name,
          version: spec.version,
          platform: spec.platform,
          sha256: spec.sha256,
          archive: spec.archive,
          entrypoint: spec.entrypoint,
          ...(spec.imagePathEnvVar
            ? { imagePathEnvVar: spec.imagePathEnvVar }
            : {}),
          fetchUrl: () => presignSandboxAssetUrl(spec),
          loadContent: () => loadSandboxAssetContent(spec),
        });
      }
      const resolutions = await ensureRuntimeAssets({
        session: input.session,
        assets: plans,
        logger,
        ...(input.job
          ? { toolCallKey: input.job.toolCallId ?? input.job.jobId }
          : {}),
      });
      return [...unknown, ...resolutions];
    },
  };
}

export async function loadDefaultSandboxService(): Promise<AgentSandboxServiceLike | null> {
  try {
    const module = await import(
      "../../modules/threads/agent/sandbox-service/service"
    );
    return module.agentSandboxService as unknown as AgentSandboxServiceLike;
  } catch (error) {
    logger.warn("deliverable_sandbox_service_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
