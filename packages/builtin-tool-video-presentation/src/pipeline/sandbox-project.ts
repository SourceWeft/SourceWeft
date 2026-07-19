import { randomUUID } from "node:crypto";
import type {
  DeliverableHostLogger,
  DeliverableJobEnvelope,
  DeliverableSandboxSession,
} from "@sourceweft/capability-contracts";
import {
  VIDEO_PRESENTATION_ERROR_CODES,
  type VideoPresentationCreateRequest,
  type VideoPresentationProjectPayload,
} from "@sourceweft/contracts/video-presentation";
import type { ProjectExecutionResult, VideoPipelineDeps } from "./deps";
import {
  isVideoPresentationSandboxError,
  videoPresentationSandboxError,
} from "./errors";
import { buildProjectCodePayload } from "./project-code";
import { safeStorageSegment, shellQuote } from "./util";

const {
  sandboxUnavailable: VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE,
  sandboxExecutionFailed: VIDEO_PRESENTATION_SANDBOX_EXECUTION_FAILED,
} = VIDEO_PRESENTATION_ERROR_CODES;

export type SandboxExecuteLikeResult = {
  exitCode: number | null;
  output: string;
  truncated?: boolean;
};

export function projectExecutionResultFromSandbox(
  result: SandboxExecuteLikeResult,
): ProjectExecutionResult {
  const output = result.output.trim();
  const ok = result.exitCode === 0;
  return {
    ok,
    diagnostics: ok ? [] : [output || `Command exited with ${result.exitCode}`],
    stdout: ok ? output : "",
    stderr: ok ? "" : output,
  };
}

export async function runGeneratedProject(input: {
  deps: VideoPipelineDeps;
  job: DeliverableJobEnvelope;
  payload: VideoPresentationProjectPayload;
  request: VideoPresentationCreateRequest;
}) {
  const runProject = input.deps.sandbox?.runProject;
  if (!runProject) {
    throw videoPresentationSandboxError(
      VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE,
      "Video presentation generation requires a configured sandbox runtime.",
    );
  }

  try {
    return await runProject({
      job: input.job,
      payload: input.payload,
      request: input.request,
    });
  } catch (error) {
    if (isVideoPresentationSandboxError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw videoPresentationSandboxError(
      VIDEO_PRESENTATION_SANDBOX_EXECUTION_FAILED,
      `Video presentation sandbox execution failed: ${message}`,
    );
  }
}

/**
 * Run the generated Remotion project inside a host-provided sandbox session.
 * Reimplements the worker's sandbox command orchestration on top of the
 * generic DeliverableSandboxSession primitives.
 */
export async function runProjectInSession(input: {
  session: DeliverableSandboxSession;
  logger: DeliverableHostLogger;
  job: DeliverableJobEnvelope;
  payload: VideoPresentationProjectPayload;
}): Promise<{
  install: ProjectExecutionResult;
  typecheck: ProjectExecutionResult;
  smoke: ProjectExecutionResult;
  stills?: Array<{ slideNumber: number; data: Uint8Array }>;
}> {
  try {
    const projectCode = buildProjectCodePayload(input.payload);
    const root = `${input.session.rootDir}/video-presentation-${safeStorageSegment(input.job.artifactId)}`;
    const files = projectCode.files.map(
      (file) =>
        [`${root}/${file.path}`, new TextEncoder().encode(file.content)] as [
          string,
          Uint8Array,
        ],
    );
    const uploads = await input.session.uploadFiles(files);
    const uploadError = uploads.find((upload) => upload.error);
    if (uploadError) {
      return {
        install: {
          ok: false,
          diagnostics: [
            `Failed to upload ${uploadError.path}: ${uploadError.error}`,
          ],
          stderr: String(uploadError.error),
        },
        typecheck: { ok: false, diagnostics: [] },
        smoke: { ok: false, diagnostics: [] },
      };
    }

    // Unique per invocation: sandbox executes are locked by toolCallId, and a
    // stage retry must never collide with a still-running (or stuck) earlier
    // execute of the same command.
    const runNonce = randomUUID().slice(0, 8);
    let runSequence = 0;
    const run = async (command: string) => {
      runSequence += 1;
      return projectExecutionResultFromSandbox(
        await input.session.execute(`cd ${shellQuote(root)} && ${command}`, {
          toolCallId: `${input.job.toolCallId ?? input.job.jobId}:${safeStorageSegment(command).slice(0, 40)}:${runNonce}-${runSequence}`,
        }),
      );
    };
    const install = await run("pnpm install");
    const typecheck = install.ok
      ? await run("pnpm run build")
      : { ok: false, diagnostics: [] };
    const smoke =
      install.ok && typecheck.ok
        ? await run("pnpm run render-smoke")
        : { ok: false, diagnostics: [] };

    // Best-effort still rendering for visual QA. The renderer deps install
    // and chromium may fail or time out in the sandbox, so every step here
    // degrades to "no stills" instead of failing the pipeline. Renderer deps
    // are installed separately to keep the critical-path install light.
    let stills: Array<{ slideNumber: number; data: Uint8Array }> = [];
    if (install.ok && typecheck.ok && smoke.ok) {
      const rendererInstall = await run(
        "pnpm add @remotion/bundler@^4.0.0 @remotion/renderer@^4.0.0",
      );
      const stillsRun = rendererInstall.ok
        ? await run("pnpm run render-stills")
        : rendererInstall;
      if (stillsRun.ok) {
        const paths = input.payload.sceneModules.map(
          (scene) => `${root}/out/slide-${scene.slideNumber}.jpeg`,
        );
        const downloads = await input.session.downloadFiles(paths);
        stills = input.payload.sceneModules.flatMap((scene, index) => {
          const download = downloads[index];
          return download?.content && !download.error
            ? [{ slideNumber: scene.slideNumber, data: download.content }]
            : [];
        });
      } else {
        input.logger.warn("video_presentation_render_stills_unavailable", {
          artifactId: input.job.artifactId,
          jobId: input.job.jobId,
          diagnostics: stillsRun.diagnostics.slice(0, 3),
        });
      }
    }
    return { install, typecheck, smoke, stills };
  } catch (error) {
    input.logger.warn("Video presentation sandbox execution failed", {
      error: error instanceof Error ? error.message : String(error),
      artifactId: input.job.artifactId,
      jobId: input.job.jobId,
    });
    throw error;
  }
}
