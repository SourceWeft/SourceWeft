import { ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES } from "@sourceweft/contracts/artifact-storage";
import type {
  AgentToolSandboxHostLimits,
  AgentToolSandboxServices,
} from "@sourceweft/contracts/agent-tools";
import { REMOTION_RENDERER_VERSION } from "../pipeline/renderer-version";
import { shellQuote } from "../pipeline/util";
import { sha256Digest } from "./common";

export type VideoPresentationRenderPolicy = Readonly<{
  version: "video-render-policy";
  rendererVersion: string;
  codec: "h264";
  mimeType: "video/mp4";
  overallTimeoutMs: number;
  commandTimeoutMs: number;
  maxOutputBytes: number;
  maxSampleBytes: number;
  outputSafetyRatio: number;
  audioBitrateBps: number;
  minimumVideoBitrateBps: number;
  concurrency: number;
}>;

export const VIDEO_PRESENTATION_RENDER_POLICY: VideoPresentationRenderPolicy =
  Object.freeze({
    version: "video-render-policy",
    rendererVersion: REMOTION_RENDERER_VERSION,
    codec: "h264" as const,
    mimeType: "video/mp4" as const,
    // Rendering an 85-second 1080p composition is multi-command batch work.
    // Keep the hard liveness bound aligned with the host's batch budget; the
    // tighter 120s warm-performance target belongs to the benchmark, not the
    // correctness path.
    overallTimeoutMs: 8 * 60_000,
    commandTimeoutMs: 120_000,
    maxOutputBytes: ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES,
    maxSampleBytes: ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES,
    outputSafetyRatio: 0.9,
    audioBitrateBps: 128_000,
    minimumVideoBitrateBps: 150_000,
    concurrency: 1,
  });

export function resolveVideoPresentationRenderPolicy(
  hostLimits?: AgentToolSandboxHostLimits,
  basePolicy: VideoPresentationRenderPolicy = VIDEO_PRESENTATION_RENDER_POLICY,
): VideoPresentationRenderPolicy {
  if (!hostLimits) return basePolicy;
  return Object.freeze({
    ...basePolicy,
    commandTimeoutMs: Math.min(
      basePolicy.commandTimeoutMs,
      hostLimits.commandTimeoutMs,
    ),
    maxOutputBytes: Math.min(
      basePolicy.maxOutputBytes,
      hostLimits.maxDownloadFileBytes,
      hostLimits.maxDownloadTotalBytes,
    ),
    maxSampleBytes: Math.min(
      basePolicy.maxSampleBytes,
      hostLimits.maxDownloadTotalBytes,
    ),
  });
}

export type VideoPresentationRenderProject = {
  readonly durationInFrames: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly narrationEnabled: boolean;
  readonly scenes: readonly {
    readonly slideNumber: number;
    readonly durationInFrames: number;
  }[];
};

export type VideoPresentationRenderSampleDescriptor = {
  readonly slideNumber: number;
  readonly sampleId: "begin" | "middle" | "end";
  readonly frame: number;
  readonly relativePath: string;
};

export type VideoPresentationRenderedSample =
  VideoPresentationRenderSampleDescriptor & {
    readonly data: Uint8Array;
    readonly mimeType: "image/jpeg";
  };

export type VideoPresentationRenderTimings = {
  readonly prepareMs: number;
  readonly samplesMs: number;
  readonly scenesMs: number;
  readonly audioMs: number;
  readonly muxMs: number;
  readonly probeMs: number;
  readonly downloadMs: number;
  readonly totalMs: number;
};

export type VideoPresentationRenderOutput = {
  readonly bytes: Uint8Array;
  readonly report: {
    readonly byteLength: number;
    readonly contentDigest: string;
    readonly durationInFrames: number;
    readonly fps: number;
    readonly width: number;
    readonly height: number;
    readonly hasAudio: boolean;
    readonly mimeType: "video/mp4";
    readonly renderPolicyVersion: string;
    readonly rendererVersion: string;
  };
  readonly timings: VideoPresentationRenderTimings;
};

export type VideoPresentationPreparedRenderSession = {
  renderSamples(): Promise<readonly VideoPresentationRenderedSample[]>;
  renderFinal(): Promise<VideoPresentationRenderOutput>;
  dispose(): Promise<void>;
};

export type VideoPresentationRenderPort = {
  prepare(input: {
    readonly canonicalRoot: string;
    readonly project: VideoPresentationRenderProject;
    readonly samples: readonly VideoPresentationRenderSampleDescriptor[];
    readonly signal?: AbortSignal;
  }): Promise<VideoPresentationPreparedRenderSession>;
};

type RenderStage =
  "prepare" | "samples" | "scene" | "audio" | "mux" | "probe" | "download";

export class VideoPresentationRenderError extends Error {
  constructor(
    readonly code: string,
    readonly stage: RenderStage,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "VideoPresentationRenderError";
  }

  toDiagnostic() {
    return {
      code: this.code,
      stage: this.stage,
      message: this.message,
      ...this.details,
    };
  }
}

function requirePositiveInteger(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VideoPresentationRenderError(
      "VIDEO_RENDER_PROJECT_INVALID",
      "prepare",
      `${name} must be a positive integer.`,
      { [name]: value },
    );
  }
}

function validateProject(project: VideoPresentationRenderProject) {
  requirePositiveInteger("durationInFrames", project.durationInFrames);
  requirePositiveInteger("fps", project.fps);
  requirePositiveInteger("width", project.width);
  requirePositiveInteger("height", project.height);
  if (project.scenes.length === 0) {
    throw new VideoPresentationRenderError(
      "VIDEO_RENDER_PROJECT_INVALID",
      "prepare",
      "The render project has no scenes.",
    );
  }
  let frameCount = 0;
  const slideNumbers = new Set<number>();
  for (const scene of project.scenes) {
    requirePositiveInteger("slideNumber", scene.slideNumber);
    requirePositiveInteger("sceneDurationInFrames", scene.durationInFrames);
    if (slideNumbers.has(scene.slideNumber)) {
      throw new VideoPresentationRenderError(
        "VIDEO_RENDER_PROJECT_INVALID",
        "prepare",
        `Slide ${scene.slideNumber} appears more than once.`,
      );
    }
    slideNumbers.add(scene.slideNumber);
    frameCount += scene.durationInFrames;
  }
  if (frameCount !== project.durationInFrames) {
    throw new VideoPresentationRenderError(
      "VIDEO_RENDER_TIMELINE_MISMATCH",
      "prepare",
      "Scene frame ranges do not cover the declared composition timeline.",
      { declaredFrames: project.durationInFrames, sceneFrames: frameCount },
    );
  }
}

export function deriveVideoRenderBitrate(input: {
  readonly durationInFrames: number;
  readonly fps: number;
  readonly narrationEnabled: boolean;
  readonly policy?: VideoPresentationRenderPolicy;
}) {
  const policy = input.policy ?? VIDEO_PRESENTATION_RENDER_POLICY;
  const durationSeconds = input.durationInFrames / input.fps;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new VideoPresentationRenderError(
      "VIDEO_RENDER_PROJECT_INVALID",
      "prepare",
      "The render duration is invalid.",
    );
  }
  const availableBits = policy.maxOutputBytes * 8 * policy.outputSafetyRatio;
  const audioBitrateBps = input.narrationEnabled ? policy.audioBitrateBps : 0;
  const videoBitrateBps = Math.floor(
    availableBits / durationSeconds - audioBitrateBps,
  );
  if (videoBitrateBps < policy.minimumVideoBitrateBps) {
    throw new VideoPresentationRenderError(
      "VIDEO_RENDER_BYTE_BUDGET_IMPOSSIBLE",
      "prepare",
      "The requested timeline cannot fit the configured MP4 byte ceiling.",
      {
        durationSeconds,
        maxOutputBytes: policy.maxOutputBytes,
        minimumVideoBitrateBps: policy.minimumVideoBitrateBps,
      },
    );
  }
  return {
    audioBitrateBps,
    videoBitrateBps,
    remotionVideoBitrate: `${Math.floor(videoBitrateBps / 1000)}k`,
    projectedBytes: Math.ceil(
      ((videoBitrateBps + audioBitrateBps) * durationSeconds) / 8,
    ),
  };
}

function safeRelativePath(value: string) {
  if (
    !value ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new VideoPresentationRenderError(
      "VIDEO_RENDER_SAMPLE_PATH_INVALID",
      "prepare",
      "A validation sample path is not a safe project-relative path.",
      { path: value },
    );
  }
  return value;
}

function reportLine(output: string, stage: string) {
  for (const line of output.split(/\r?\n/u).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes(`\"${stage}\"`)) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Keep scanning bounded command output for the host report line.
    }
  }
  return null;
}

function parseDigest(value: unknown) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value)
    ? value
    : null;
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseFraction(value: unknown) {
  if (typeof value !== "string") return null;
  const [numeratorText, denominatorText] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText ?? "1");
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return null;
  }
  return numerator / denominator;
}

function parseProbe(output: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const streams = Array.isArray(record.streams)
    ? (record.streams as Array<Record<string, unknown>>)
    : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const format =
    record.format && typeof record.format === "object"
      ? (record.format as Record<string, unknown>)
      : null;
  if (!video || !format) return null;
  const fps =
    parseFraction(video.avg_frame_rate) ?? parseFraction(video.r_frame_rate);
  const durationSeconds = Number(video.duration ?? format.duration);
  const frameCount = Number(video.nb_read_frames ?? video.nb_frames);
  const width = Number(video.width);
  const height = Number(video.height);
  const parsedAudioDurationSeconds = audio
    ? Number(audio.duration)
    : Number.NaN;
  const audioDurationSeconds =
    audio &&
    Number.isFinite(parsedAudioDurationSeconds) &&
    parsedAudioDurationSeconds > 0
      ? parsedAudioDurationSeconds
      : null;
  if (
    typeof fps !== "number" ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    !Number.isSafeInteger(frameCount) ||
    frameCount <= 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    return null;
  }
  return {
    fps,
    durationSeconds,
    frameCount,
    width,
    height,
    hasAudio: Boolean(audio),
    audioDurationSeconds,
  };
}

function isFastStartMp4(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types: string[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const size32 = view.getUint32(offset);
    const type = new TextDecoder("ascii").decode(
      bytes.subarray(offset + 4, offset + 8),
    );
    let headerBytes = 8;
    let boxBytes = size32;
    if (size32 === 1) {
      if (offset + 16 > bytes.byteLength) return false;
      const extended = view.getBigUint64(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      boxBytes = Number(extended);
      headerBytes = 16;
    } else if (size32 === 0) {
      boxBytes = bytes.byteLength - offset;
    }
    if (boxBytes < headerBytes || offset + boxBytes > bytes.byteLength) {
      return false;
    }
    types.push(type);
    offset += boxBytes;
  }
  if (offset !== bytes.byteLength) return false;
  const ftyp = types.indexOf("ftyp");
  const moov = types.indexOf("moov");
  const mdat = types.indexOf("mdat");
  return ftyp >= 0 && moov > ftyp && mdat > moov;
}

function abortMessage(input: {
  deadlineExpired: boolean;
  signal?: AbortSignal;
}) {
  const reason = input.signal?.reason;
  const reasonRecord =
    reason && typeof reason === "object"
      ? (reason as Record<string, unknown>)
      : null;
  const reasonMarker = [
    reasonRecord?.name,
    reasonRecord?.code,
    reasonRecord?.message,
    reason,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const timedOut =
    input.deadlineExpired ||
    reasonMarker.includes("timeout") ||
    reasonMarker.includes("timed_out");
  return timedOut
    ? new VideoPresentationRenderError(
        "VIDEO_RENDER_TIMEOUT",
        "download",
        "The trusted render exceeded its active render/download budget.",
      )
    : new VideoPresentationRenderError(
        "VIDEO_RENDER_CANCELLED",
        "download",
        "The trusted render was cancelled.",
        { upstreamAborted: input.signal?.aborted === true },
      );
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

export function createSandboxVideoPresentationRenderPort(input: {
  readonly sandbox: AgentToolSandboxServices;
  /** Deterministic test/benchmark seam; production uses the versioned policy. */
  readonly policy?: VideoPresentationRenderPolicy;
}): VideoPresentationRenderPort {
  const executeCurrent = input.sandbox.executeCurrent;
  const ensureCurrentSession = input.sandbox.ensureCurrentSession;
  if (!executeCurrent || !ensureCurrentSession) {
    throw new Error("VIDEO_RENDER_TRUSTED_SANDBOX_REQUIRED");
  }
  return {
    async prepare(prepareInput) {
      validateProject(prepareInput.project);
      const samples = prepareInput.samples.map((sample) => ({
        ...sample,
        relativePath: safeRelativePath(sample.relativePath),
      }));
      const sandboxSession = await ensureCurrentSession();
      const policy = resolveVideoPresentationRenderPolicy(
        sandboxSession.hostLimits,
        input.policy ?? VIDEO_PRESENTATION_RENDER_POLICY,
      );
      const browserExecutable =
        sandboxSession.runtimeAssets?.["chrome-headless-shell"];
      const bitrate = deriveVideoRenderBitrate({
        durationInFrames: prepareInput.project.durationInFrames,
        fps: prepareInput.project.fps,
        narrationEnabled: prepareInput.project.narrationEnabled,
        policy,
      });
      const timings = {
        prepareMs: 0,
        samplesMs: 0,
        scenesMs: 0,
        audioMs: 0,
        muxMs: 0,
        probeMs: 0,
        downloadMs: 0,
      };
      let deadlineExpired = false;
      let activeElapsedMs = 0;
      let disposed = false;
      let samplesRendered = false;
      let finalRendered = false;
      const controller = new AbortController();
      const abortFromUpstream = () =>
        controller.abort(
          prepareInput.signal?.reason ?? new Error("upstream aborted"),
        );
      prepareInput.signal?.addEventListener("abort", abortFromUpstream, {
        once: true,
      });
      if (prepareInput.signal?.aborted) abortFromUpstream();
      const assertActive = (stage: RenderStage) => {
        if (disposed) {
          throw new VideoPresentationRenderError(
            "VIDEO_RENDER_SESSION_DISPOSED",
            stage,
            "The prepared render session is already disposed.",
          );
        }
        if (controller.signal.aborted) {
          const error = abortMessage({
            deadlineExpired,
            signal: prepareInput.signal,
          });
          throw new VideoPresentationRenderError(
            error.code,
            stage,
            error.message,
            error.details,
          );
        }
      };

      const expireDeadline = () => {
        if (controller.signal.aborted) return;
        deadlineExpired = true;
        controller.abort(new Error("render deadline exceeded"));
      };

      /**
       * Charge only sandbox render and download work to the render budget.
       * The prepared bundle may remain idle while the caller performs visual
       * review without turning provider latency into a render timeout.
       */
      const runActive = async <T>(
        stage: RenderStage,
        timing: keyof typeof timings,
        operation: (input: {
          signal: AbortSignal;
          remainingMs: number;
        }) => Promise<T>,
        options: { awaitAbortCleanup?: boolean } = {},
      ) => {
        assertActive(stage);
        const remainingMs = policy.overallTimeoutMs - activeElapsedMs;
        if (remainingMs <= 0) {
          expireDeadline();
          assertActive(stage);
        }
        const operationStartedAt = Date.now();
        const allowedMs = Math.max(1, Math.floor(remainingMs));
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        let rejectOnAbort: (() => void) | undefined;
        deadlineTimer = setTimeout(expireDeadline, allowedMs);
        deadlineTimer.unref?.();
        let result: T;
        try {
          const pending = operation({
            signal: controller.signal,
            remainingMs: allowedMs,
          });
          if (options.awaitAbortCleanup) {
            // Trusted sandbox execution owns remote cancellation. Await it so
            // timeout/cancel cannot return while the provider is still running.
            result = await pending;
          } else {
            const interrupted = new Promise<never>((_resolve, reject) => {
              rejectOnAbort = () =>
                reject(
                  controller.signal.reason ??
                    new Error("render was interrupted"),
                );
              controller.signal.addEventListener("abort", rejectOnAbort, {
                once: true,
              });
            });
            result = await Promise.race([pending, interrupted]);
          }
        } catch (error) {
          if (
            controller.signal.aborted &&
            errorCode(error) !== "SANDBOX_TERMINATION_UNKNOWN"
          ) {
            assertActive(stage);
          }
          throw error;
        } finally {
          if (deadlineTimer) clearTimeout(deadlineTimer);
          if (rejectOnAbort) {
            controller.signal.removeEventListener("abort", rejectOnAbort);
          }
          const elapsedMs = Math.max(0, Date.now() - operationStartedAt);
          activeElapsedMs += elapsedMs;
          timings[timing] += elapsedMs;
        }
        if (activeElapsedMs > policy.overallTimeoutMs) {
          expireDeadline();
        }
        assertActive(stage);
        return result;
      };

      const execute = async (
        stage: RenderStage,
        command: string,
        timing: keyof typeof timings,
      ) => {
        let result: Awaited<ReturnType<typeof executeCurrent>>;
        try {
          result = await runActive(
            stage,
            timing,
            ({ signal, remainingMs }) =>
              executeCurrent({
                command: `${
                  browserExecutable
                    ? `export SOURCEWEFT_REMOTION_BROWSER=${shellQuote(browserExecutable)} && `
                    : ""
                }cd ${shellQuote(prepareInput.canonicalRoot)} && ${command}`,
                timeoutMs: Math.max(
                  1,
                  Math.min(policy.commandTimeoutMs, remainingMs),
                ),
                signal,
              }),
            { awaitAbortCleanup: true },
          );
        } catch (error) {
          if (error instanceof VideoPresentationRenderError) throw error;
          if (errorCode(error) === "SANDBOX_TERMINATION_UNKNOWN") {
            throw new VideoPresentationRenderError(
              "SANDBOX_TERMINATION_UNKNOWN",
              stage,
              "[SANDBOX_TERMINATION_UNKNOWN] The sandbox provider could not confirm that rendering stopped.",
            );
          }
          const message =
            error instanceof Error ? error.message : String(error);
          throw new VideoPresentationRenderError(
            /SANDBOX_COMMAND_TIMEOUT|timed?\s*out|timeout exceeded/iu.test(
              message,
            )
              ? "VIDEO_RENDER_TIMEOUT"
              : "VIDEO_RENDER_SANDBOX_FAILED",
            stage,
            message,
          );
        }
        if (result.exitCode !== 0 || result.truncated) {
          const timedOut =
            /SANDBOX_COMMAND_TIMEOUT|timed?\s*out|timeout exceeded/iu.test(
              result.output,
            );
          throw new VideoPresentationRenderError(
            result.truncated
              ? "VIDEO_RENDER_COMMAND_OUTPUT_TRUNCATED"
              : timedOut
                ? "VIDEO_RENDER_TIMEOUT"
                : "VIDEO_RENDER_COMMAND_FAILED",
            stage,
            `Trusted ${stage} command did not complete successfully.`,
            {
              exitCode: result.exitCode,
              output: result.output.slice(0, 2_000),
              truncated: result.truncated === true,
            },
          );
        }
        return result;
      };

      try {
        await execute("prepare", "pnpm run prepare-render", "prepareMs");
      } catch (error) {
        prepareInput.signal?.removeEventListener("abort", abortFromUpstream);
        throw error;
      }

      return {
        async renderSamples() {
          assertActive("samples");
          if (samplesRendered) {
            throw new VideoPresentationRenderError(
              "VIDEO_RENDER_SAMPLES_ALREADY_RENDERED",
              "samples",
              "Validation samples may be rendered only once per prepared session.",
            );
          }
          await execute(
            "samples",
            "pnpm run render-validation-samples",
            "samplesMs",
          );
          const rendered: VideoPresentationRenderedSample[] = [];
          let renderedSampleBytes = 0;
          for (const sample of samples) {
            const path = `${prepareInput.canonicalRoot}/${sample.relativePath}`;
            let data: Uint8Array;
            try {
              data = new Uint8Array(
                await runActive(
                  "download",
                  "downloadMs",
                  ({ signal, remainingMs }) =>
                    input.sandbox.downloadCurrentFile({
                      sandboxPath: path,
                      signal,
                      timeoutMs: Math.max(
                        1,
                        Math.min(policy.commandTimeoutMs, remainingMs),
                      ),
                    }),
                  { awaitAbortCleanup: true },
                ),
              );
            } catch (error) {
              if (error instanceof VideoPresentationRenderError) throw error;
              throw new VideoPresentationRenderError(
                "VIDEO_RENDER_SAMPLE_MISSING",
                "download",
                `Validation sample is unavailable for slide ${sample.slideNumber}.`,
                {
                  path,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
            }
            if (data.byteLength === 0) {
              throw new VideoPresentationRenderError(
                "VIDEO_RENDER_SAMPLE_EMPTY",
                "download",
                `Validation sample is empty for slide ${sample.slideNumber}.`,
                { path },
              );
            }
            renderedSampleBytes += data.byteLength;
            if (renderedSampleBytes > policy.maxSampleBytes) {
              throw new VideoPresentationRenderError(
                "VIDEO_RENDER_SAMPLE_BYTES_EXCEEDED",
                "download",
                "Validation samples exceed the cumulative download ceiling.",
                {
                  byteLength: renderedSampleBytes,
                  maxBytes: policy.maxSampleBytes,
                },
              );
            }
            rendered.push({ ...sample, data, mimeType: "image/jpeg" });
          }
          samplesRendered = true;
          return rendered;
        },

        async renderFinal() {
          assertActive("scene");
          if (!samplesRendered) {
            throw new VideoPresentationRenderError(
              "VIDEO_RENDER_SAMPLES_REQUIRED",
              "scene",
              "Final rendering requires completed validation samples.",
            );
          }
          if (finalRendered) {
            throw new VideoPresentationRenderError(
              "VIDEO_RENDER_FINAL_ALREADY_RENDERED",
              "scene",
              "Final media may be rendered only once per prepared session.",
            );
          }

          let frameCursor = 0;
          for (const scene of prepareInput.project.scenes) {
            const from = frameCursor;
            const to = from + scene.durationInFrames - 1;
            frameCursor = to + 1;
            const result = await execute(
              "scene",
              `SOURCEWEFT_VIDEO_BITRATE=${shellQuote(bitrate.remotionVideoBitrate)} SOURCEWEFT_VIDEO_CONCURRENCY=${policy.concurrency} pnpm run render-scene -- ${scene.slideNumber}`,
              "scenesMs",
            );
            const report = reportLine(result.output, "render-scene");
            if (
              !report ||
              report.ok !== true ||
              report.slideNumber !== scene.slideNumber ||
              numberField(report, "from") !== from ||
              numberField(report, "to") !== to ||
              (numberField(report, "byteLength") ?? 0) <= 0 ||
              !parseDigest(report.contentDigest)
            ) {
              throw new VideoPresentationRenderError(
                "VIDEO_RENDER_SCENE_REPORT_INVALID",
                "scene",
                `Scene ${scene.slideNumber} did not produce a valid chunk report.`,
                { expectedFrom: from, expectedTo: to },
              );
            }
          }

          const audioResult = await execute(
            "audio",
            `SOURCEWEFT_AUDIO_BITRATE=${Math.floor(policy.audioBitrateBps / 1000)}k pnpm run render-audio`,
            "audioMs",
          );
          const audio = reportLine(audioResult.output, "render-audio");
          const audioValid = prepareInput.project.narrationEnabled
            ? audio?.ok === true &&
              audio.file === "out/audio.aac" &&
              (numberField(audio, "byteLength") ?? 0) > 0 &&
              Boolean(parseDigest(audio.contentDigest))
            : audio?.ok === true &&
              audio.file === null &&
              numberField(audio, "byteLength") === 0;
          if (!audioValid) {
            throw new VideoPresentationRenderError(
              "VIDEO_RENDER_AUDIO_REPORT_INVALID",
              "audio",
              "The narration render report does not match the narration policy.",
              { narrationEnabled: prepareInput.project.narrationEnabled },
            );
          }

          const muxResult = await execute(
            "mux",
            "pnpm run concat-video",
            "muxMs",
          );
          const mux = reportLine(muxResult.output, "render-video");
          if (
            !mux ||
            mux.ok !== true ||
            mux.file !== "out/video.mp4" ||
            numberField(mux, "durationInFrames") !==
              prepareInput.project.durationInFrames ||
            numberField(mux, "fps") !== prepareInput.project.fps ||
            numberField(mux, "width") !== prepareInput.project.width ||
            numberField(mux, "height") !== prepareInput.project.height ||
            mux.hasAudio !== prepareInput.project.narrationEnabled ||
            (numberField(mux, "byteLength") ?? 0) <= 0 ||
            !parseDigest(mux.contentDigest)
          ) {
            throw new VideoPresentationRenderError(
              "VIDEO_RENDER_MUX_REPORT_INVALID",
              "mux",
              "The final mux report does not match the canonical project.",
            );
          }

          const probeResult = await execute(
            "probe",
            "ffprobe -v error -count_frames -show_entries 'format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate,duration,nb_read_frames,nb_frames' -of json -- out/video.mp4",
            "probeMs",
          );
          const probe = parseProbe(probeResult.output);
          const expectedDurationSeconds =
            prepareInput.project.durationInFrames / prepareInput.project.fps;
          const durationToleranceSeconds = Math.max(
            0.1,
            2 / prepareInput.project.fps,
          );
          const audioDurationValid = prepareInput.project.narrationEnabled
            ? probe?.audioDurationSeconds !== null &&
              probe?.audioDurationSeconds !== undefined &&
              Math.abs(probe.audioDurationSeconds - expectedDurationSeconds) <=
                durationToleranceSeconds
            : probe?.audioDurationSeconds === null;
          if (
            !probe ||
            Math.abs(probe.fps - prepareInput.project.fps) > 0.001 ||
            probe.frameCount !== prepareInput.project.durationInFrames ||
            probe.width !== prepareInput.project.width ||
            probe.height !== prepareInput.project.height ||
            probe.hasAudio !== prepareInput.project.narrationEnabled ||
            !audioDurationValid ||
            Math.abs(probe.durationSeconds - expectedDurationSeconds) >
              1 / prepareInput.project.fps + 0.01
          ) {
            throw new VideoPresentationRenderError(
              "VIDEO_RENDER_MEDIA_PROBE_MISMATCH",
              "probe",
              "Host media probing did not confirm the canonical video metadata.",
              { probe, expectedDurationSeconds },
            );
          }

          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(
              await runActive(
                "download",
                "downloadMs",
                ({ signal, remainingMs }) =>
                  input.sandbox.downloadCurrentFile({
                    sandboxPath: `${prepareInput.canonicalRoot}/out/video.mp4`,
                    signal,
                    timeoutMs: Math.max(
                      1,
                      Math.min(policy.commandTimeoutMs, remainingMs),
                    ),
                  }),
                { awaitAbortCleanup: true },
              ),
            );
          } catch (error) {
            if (error instanceof VideoPresentationRenderError) throw error;
            throw new VideoPresentationRenderError(
              "VIDEO_RENDER_MP4_DOWNLOAD_FAILED",
              "download",
              error instanceof Error ? error.message : String(error),
            );
          }
          if (
            bytes.byteLength === 0 ||
            bytes.byteLength > policy.maxOutputBytes
          ) {
            throw new VideoPresentationRenderError(
              "VIDEO_RENDER_MP4_SIZE_INVALID",
              "download",
              "The final MP4 is empty or exceeds the configured byte ceiling.",
              { byteLength: bytes.byteLength, maxBytes: policy.maxOutputBytes },
            );
          }
          const contentDigest = sha256Digest(bytes);
          if (
            numberField(mux, "byteLength") !== bytes.byteLength ||
            parseDigest(mux.contentDigest) !== contentDigest
          ) {
            throw new VideoPresentationRenderError(
              "VIDEO_RENDER_MP4_INTEGRITY_MISMATCH",
              "download",
              "The downloaded MP4 does not match the mux report.",
              { byteLength: bytes.byteLength, contentDigest },
            );
          }
          if (!isFastStartMp4(bytes)) {
            throw new VideoPresentationRenderError(
              "VIDEO_RENDER_MP4_NOT_STREAMABLE",
              "download",
              "The final MP4 does not place its moov metadata before media data.",
            );
          }
          finalRendered = true;
          return {
            bytes,
            report: {
              byteLength: bytes.byteLength,
              contentDigest,
              durationInFrames: prepareInput.project.durationInFrames,
              fps: prepareInput.project.fps,
              width: prepareInput.project.width,
              height: prepareInput.project.height,
              hasAudio: prepareInput.project.narrationEnabled,
              mimeType: policy.mimeType,
              renderPolicyVersion: policy.version,
              rendererVersion: policy.rendererVersion,
            },
            timings: {
              ...timings,
              totalMs: activeElapsedMs,
            },
          };
        },

        async dispose() {
          if (disposed) return;
          disposed = true;
          prepareInput.signal?.removeEventListener("abort", abortFromUpstream);
        },
      };
    },
  };
}
