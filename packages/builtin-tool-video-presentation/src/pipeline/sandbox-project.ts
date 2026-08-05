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
  REMOTION_BROWSER_ENV_VAR,
  REMOTION_RENDERER_VERSION,
} from "./renderer-version";
import {
  isVideoPresentationSandboxError,
  videoPresentationSandboxError,
} from "./errors";
import {
  buildProjectCodePayload,
  PROJECT_NARRATION_DIR,
  type ProjectNarrationFile,
} from "./project-code";
import {
  classifyRenderVideoFailure,
  CONCAT_VIDEO_COMMAND,
  MAX_RENDERED_VIDEO_BYTES,
  NARRATION_AUDIO_COMMAND,
  parseRenderVideoReport,
  parseSceneChunkReport,
  renderedVideoSandboxPath,
  renderVideoSlideNumbers,
  sceneChunkCommand,
  type RenderVideoFailureReason,
  type RenderVideoReport,
} from "./render-video";
import { safeStorageSegment, shellQuote } from "./util";

const {
  sandboxUnavailable: VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE,
  sandboxExecutionFailed: VIDEO_PRESENTATION_SANDBOX_EXECUTION_FAILED,
} = VIDEO_PRESENTATION_ERROR_CODES;

/**
 * Opt-in request for a server-side mp4 render, off unless a caller passes it.
 * A run that omits it is byte-for-byte the run that shipped before the mp4 path
 * existed, which is what keeps the browser-preview path unaffected.
 */
export type RenderVideoRequest = {
  /**
   * Narration to stage under the project's `public/audio/` so the mp4 carries
   * sound. The sandbox cannot reach the artifact asset route, so the bytes must
   * be uploaded.
   *
   * It is either empty (a deck that was never meant to speak) or complete —
   * one entry per rendered scene. Partial narration is rejected below rather
   * than rendered: see `narration_missing`.
   */
  narration?: ReadonlyArray<{
    slideNumber: number;
    fileName: string;
    data: Uint8Array;
    /**
     * The staged bytes' measured length (see `StagedNarrationTrack`). It is
     * required, not optional: it is the only number in the generated manifest
     * that was not derived from the same measurement the scene lengths were,
     * which is the whole reason `render-smoke` can now catch a scene that is
     * too short for its narration.
     */
    durationSeconds: number;
  }>;
};

export type RenderedVideoResult = {
  data: Uint8Array;
  report: RenderVideoReport;
};

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
  /** Opt-in mp4 render; `installing_project` passes it (see RenderVideoRequest). */
  renderVideo?: RenderVideoRequest;
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
      ...(input.renderVideo ? { renderVideo: input.renderVideo } : {}),
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
  /** Opt-in: also render the composition to mp4 (see RenderVideoRequest). */
  renderVideo?: RenderVideoRequest;
  /**
   * Absolute path of a platform-staged Chrome Headless Shell inside the
   * sandbox (runtime-asset ladder). When set, every render command carries it
   * via SOURCEWEFT_REMOTION_BROWSER and Remotion never downloads a browser;
   * when absent the generated scripts fall back to Remotion's own download
   * with retries.
   */
  browserExecutablePath?: string;
}): Promise<{
  install: ProjectExecutionResult;
  typecheck: ProjectExecutionResult;
  smoke: ProjectExecutionResult;
  stills?: Array<{ slideNumber: number; data: Uint8Array }>;
  video?: RenderedVideoResult;
  stillsUnavailableReason?: string;
  videoUnavailableReason?: string;
}> {
  try {
    const narrationFiles: ProjectNarrationFile[] = (
      input.renderVideo?.narration ?? []
    ).map((track) => ({
      slideNumber: track.slideNumber,
      fileName: track.fileName,
      durationSeconds: track.durationSeconds,
    }));
    const projectCode = buildProjectCodePayload(
      input.payload,
      // Without narration this argument is omitted entirely, which keeps the
      // generated project identical to the one the pipeline persists.
      narrationFiles.length > 0 ? { narrationFiles } : undefined,
    );
    const root = `${input.session.rootDir}/video-presentation-${safeStorageSegment(input.job.artifactId)}`;
    const files: Array<[string, Uint8Array]> = projectCode.files.map(
      (file) =>
        [`${root}/${file.path}`, new TextEncoder().encode(file.content)] as [
          string,
          Uint8Array,
        ],
    );
    for (const track of input.renderVideo?.narration ?? []) {
      files.push([
        `${root}/${PROJECT_NARRATION_DIR}/${track.fileName}`,
        track.data,
      ]);
    }
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
    // Render commands carry the staged browser path as an env prefix — the
    // narrowest possible contract between the ladder and the scripts.
    const withBrowserEnv = (command: string) =>
      input.browserExecutablePath
        ? `${REMOTION_BROWSER_ENV_VAR}=${shellQuote(input.browserExecutablePath)} ${command}`
        : command;
    const runRender = (command: string) => run(withBrowserEnv(command));
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
    let video: RenderedVideoResult | undefined;
    let stillsUnavailableReason: string | undefined;
    let videoUnavailableReason: string | undefined;
    if (install.ok && typecheck.ok && smoke.ok) {
      // Exact pins, never ranges: the browser asset is verified against this
      // renderer version (renderer-version.ts, design decision A3) — a float
      // here silently decouples them.
      const rendererInstall = await run(
        `pnpm add @remotion/bundler@${REMOTION_RENDERER_VERSION} @remotion/renderer@${REMOTION_RENDERER_VERSION}`,
      );
      const stillsRun = rendererInstall.ok
        ? await runRender("pnpm run render-stills")
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
        stillsUnavailableReason =
          stillsRun.diagnostics.slice(0, 2).join("; ") ||
          stillsRun.stderr?.slice(-200) ||
          "still renderer failed";
        input.logger.warn("video_presentation_render_stills_unavailable", {
          artifactId: input.job.artifactId,
          jobId: input.job.jobId,
          diagnostics: stillsRun.diagnostics.slice(0, 3),
        });
      }

      // Opt-in mp4 render, reusing the renderer deps the stills step just
      // installed and the same `run` helper (so it inherits the sandbox's
      // command timeout, output cap, per-execute lock and cleanup policy
      // unchanged). Best-effort exactly like stills: a failed or oversized
      // render yields no video, never a pipeline failure.
      //
      // The render is a sequence of commands rather than one: N scene chunks,
      // then the narration mix, then the join. Each command carries the budget
      // of one scene instead of the whole deck, which is the only way it fits
      // inside the sandbox's 120s per-command timeout (deliberately unraised).
      if (input.renderVideo && rendererInstall.ok) {
        const warnUnavailable = (meta: Record<string, unknown>) => {
          videoUnavailableReason =
            videoUnavailableReason ??
            [meta.reason, meta.stage ?? meta.slideNumber]
              .filter((part) => part !== undefined)
              .join(" @ ");
          input.logger.warn("video_presentation_render_video_unavailable", {
            artifactId: input.job.artifactId,
            jobId: input.job.jobId,
            ...meta,
          });
        };

        // Chunks are rendered in playback order and the first failure stops the
        // sequence. A scene is never skipped to salvage the rest: the payload
        // has no way to say "this video is missing slide 4", so a short mp4
        // would be presented as the finished deliverable. Refusing costs a
        // retry; shipping a truncated deck silently misrepresents it. Stopping
        // early also avoids burning sandbox time on chunks nothing will join.
        const slideNumbers = renderVideoSlideNumbers(input.payload);

        // Audio-coverage invariant, checked before a single frame is rendered.
        //
        // Narration is mounted inside each scene's <Sequence> (see
        // `project-code.ts`), so a track staged for a slide that has no scene
        // module is never mounted and never reaches the mix, and a scene with
        // no staged track plays silent. Either way the mp4 renders fine and
        // *sounds* wrong, which is the one failure this path must not ship.
        // If this check goes, a renumbered or partially-narrated deck produces
        // a finished-looking video that is quiet in the middle.
        const narrationSlides = (input.renderVideo.narration ?? []).map(
          (track) => track.slideNumber,
        );
        const narrationCovers =
          narrationSlides.length === 0 ||
          (narrationSlides.length === slideNumbers.length &&
            slideNumbers.every((slideNumber) =>
              narrationSlides.includes(slideNumber),
            ));
        if (!narrationCovers) {
          warnUnavailable({
            reason: "narration_missing" satisfies RenderVideoFailureReason,
            stage: "stage-narration",
            narrationSlides,
            slideNumbers,
          });
        }

        let renderable = narrationCovers && slideNumbers.length > 0;
        for (const slideNumber of slideNumbers) {
          if (!renderable) {
            break;
          }
          const command = sceneChunkCommand(slideNumber);
          const sceneRun = await runRender(command);
          const chunk = sceneRun.ok
            ? parseSceneChunkReport(sceneRun.stdout, slideNumber)
            : null;
          if (!sceneRun.ok || !chunk) {
            // A single scene that still outruns the 120s budget lands here as
            // `timeout`; it is reported per slide so an operator can see which
            // scene is too heavy rather than "the render is too slow".
            warnUnavailable({
              reason: sceneRun.ok
                ? "unreadable_scene_report"
                : classifyRenderVideoFailure(sceneRun),
              slideNumber,
              diagnostics: sceneRun.diagnostics.slice(0, 3),
            });
            renderable = false;
            break;
          }
        }

        // Narration is mixed once for the whole deck (see
        // PROJECT_NARRATION_AUDIO_PATH); the command is a cheap no-op for a
        // silent deck, so it is not conditioned on the narration option here.
        if (renderable) {
          const audioRun = await runRender(NARRATION_AUDIO_COMMAND);
          if (!audioRun.ok) {
            warnUnavailable({
              reason: classifyRenderVideoFailure(audioRun),
              stage: "render-audio",
              diagnostics: audioRun.diagnostics.slice(0, 3),
            });
            renderable = false;
          }
        }

        const videoRun = renderable
          ? await run(CONCAT_VIDEO_COMMAND)
          : { ok: false, diagnostics: [], stdout: "", stderr: "" };
        const report =
          renderable && videoRun.ok
            ? parseRenderVideoReport(videoRun.stdout)
            : null;
        if (!renderable) {
          // Already warned with the specific reason above; no chunks are
          // downloaded and no partial mp4 exists to mistake for a whole one.
        } else if (!videoRun.ok || !report) {
          warnUnavailable({
            reason: videoRun.ok
              ? "unreadable_render_report"
              : // The join is a stream copy, so a failure here is a broken or
                // missing chunk far more often than a slow command.
                classifyRenderVideoFailure(videoRun) === "timeout"
                ? "timeout"
                : "concat_failed",
            diagnostics: videoRun.diagnostics.slice(0, 3),
          });
        } else if (narrationSlides.length > 0 && !report.hasAudio) {
          // The concat script derives `hasAudio` from the manifest it actually
          // read, so this is the end-to-end confirmation that the narration we
          // staged survived into the generated project and the mix. A render
          // that *succeeded* but reports no audio is not a success: it is the
          // silent-deliverable case, and it degrades to no video like any
          // other failure rather than being persisted.
          warnUnavailable({
            reason: "narration_missing" satisfies RenderVideoFailureReason,
            stage: "concat-video",
            narrationSlides,
          });
        } else if (report.byteLength > MAX_RENDERED_VIDEO_BYTES) {
          // Never pull a file past the sandbox's per-file collect budget into
          // the worker's heap; the ceiling is the sandbox's, not ours to raise.
          warnUnavailable({
            reason: "oversized",
            byteLength: report.byteLength,
          });
        } else {
          const [download] = await input.session.downloadFiles([
            renderedVideoSandboxPath(root),
          ]);
          if (download?.content && !download.error) {
            video = { data: download.content, report };
          } else {
            warnUnavailable({
              reason: "download_failed",
              error: download?.error ?? "missing",
            });
          }
        }
      }
    }
    return {
      install,
      typecheck,
      smoke,
      stills,
      ...(video ? { video } : {}),
      ...(stillsUnavailableReason ? { stillsUnavailableReason } : {}),
      ...(videoUnavailableReason ? { videoUnavailableReason } : {}),
    };
  } catch (error) {
    input.logger.warn("Video presentation sandbox execution failed", {
      error: error instanceof Error ? error.message : String(error),
      artifactId: input.job.artifactId,
      jobId: input.job.jobId,
    });
    throw error;
  }
}
