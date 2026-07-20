/**
 * Server-side mp4 render of the generated Remotion project.
 *
 * Why this exists: the browser preview compiles model-authored scene code with
 * `new Function` (see `video-presentation-runtime/src/compiler.ts`), which is
 * arbitrary code execution in a trusted context. The standing rule is that
 * risky code runs in the sandbox, so the replacement for that preview is an mp4
 * rendered by `@remotion/renderer` *inside* the sandbox — the same mechanism
 * the visual-QA stills path already uses successfully.
 *
 * The render is split across sandbox commands — one per scene, one for the
 * narration mix, one to join them — because a single sandbox command may only
 * run for `SOURCEWEFT_SANDBOX_COMMAND_TIMEOUT_MS` (120s) and that limit is
 * deliberately not being raised. This module owns the command strings and the
 * report/failure vocabulary for that sequence; `sandbox-project.ts` runs it.
 *
 * Everything here is additive and opt-in: no pipeline stage asks for an mp4
 * yet, and no consumer reads one. This module is the render + storage half of
 * that future flip.
 */
import { ARTIFACT_LIMITS } from "@sourceweft/contracts/artifact-files";
import type {
  VideoPresentationProjectPayload,
  VideoPresentationRenderedVideo,
} from "@sourceweft/contracts/video-presentation";
import type { ArtifactStorage } from "@sourceweft/contracts/artifact-storage";
import { PROJECT_RENDERED_VIDEO_PATH } from "./project-code";
import { artifactAssetUrl, safeStorageSegment } from "./util";

export const RENDERED_VIDEO_MIME_TYPE = "video/mp4";
export const RENDERED_VIDEO_EXTENSION = ".mp4";

/**
 * Refuse to pull an mp4 larger than the sandbox's default per-file collect
 * budget (`SOURCEWEFT_SANDBOX_MAX_COLLECT_FILE_BYTES`, 25MB). The download
 * primitive itself does not enforce that budget, so the ceiling is restated
 * here rather than quietly exceeded: an oversized render is reported as
 * "no video", never streamed into the worker's heap.
 */
export const MAX_RENDERED_VIDEO_BYTES = 25 * 1024 * 1024;

/** The mp4 is stored as an artifact asset, so it inherits that ceiling too. */
export const MAX_STORED_VIDEO_BYTES = Math.min(
  MAX_RENDERED_VIDEO_BYTES,
  ARTIFACT_LIMITS.fileBytes,
);

export type RenderVideoReport = {
  file: string;
  byteLength: number;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
};

/**
 * Why the mp4 render did not produce a file. Rendering is best-effort like the
 * stills path, so callers log the reason and continue; the classification
 * exists so an operator can tell "the sandbox image has no chromium" apart from
 * "the render simply takes longer than one sandbox command is allowed to run".
 */
export type RenderVideoFailureReason =
  | "timeout"
  | "renderer_unavailable"
  | "oversized"
  | "download_failed"
  | "render_failed"
  /** A scene command succeeded but printed no readable chunk report. */
  | "unreadable_scene_report"
  /** Chunks exist but joining them failed; there is no complete mp4. */
  | "concat_failed"
  /** The concat command succeeded but printed no readable video report. */
  | "unreadable_render_report";

/**
 * A single sandbox command may run for `SOURCEWEFT_SANDBOX_COMMAND_TIMEOUT_MS`
 * (120s by default) and the provider surfaces the overrun as
 * `SANDBOX_COMMAND_TIMEOUT`. Splitting the render per scene buys headroom but
 * does not remove the ceiling: one heavy scene can still exceed it, and that
 * arrives here as `timeout` for the scene's own command. The constraint is
 * deliberately not relaxed — it is classified so the caller can degrade
 * honestly instead of shipping a short video.
 */
export function classifyRenderVideoFailure(input: {
  diagnostics: readonly string[];
  stderr?: string;
}): RenderVideoFailureReason {
  const text = [...input.diagnostics, input.stderr ?? ""].join("\n");
  if (/SANDBOX_COMMAND_TIMEOUT|timed? ?out/iu.test(text)) {
    return "timeout";
  }
  if (
    /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|browser executable|chrome|chromium/iu.test(
      text,
    )
  ) {
    return "renderer_unavailable";
  }
  return "render_failed";
}

/* -------------------------------------------------------------------------- */
/* Command sequence                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The slides an mp4 render must cover, in playback order.
 *
 * Deliberately derived the same way `buildProjectCodePayload` derives the
 * composition: a payload with no scene modules is rendered as a single
 * title-card slide 1, so the render must ask for that slide and not for
 * nothing. Any divergence between these two would mean concatenating a
 * different set of scenes than the composition contains.
 */
export function renderVideoSlideNumbers(
  payload: VideoPresentationProjectPayload,
): number[] {
  return payload.sceneModules.length > 0
    ? payload.sceneModules.map((scene) => scene.slideNumber)
    : [1];
}

/**
 * One scene, one command — the whole point of the split. `--` keeps pnpm from
 * eating the slide number as one of its own flags.
 */
export function sceneChunkCommand(slideNumber: number) {
  return `pnpm run render-scene -- ${slideNumber}`;
}

/** Whole-deck narration mix; a no-op inside the script when there is none. */
export const NARRATION_AUDIO_COMMAND = "pnpm run render-audio";

/** Stream-copy join of the per-scene chunks into the deliverable mp4. */
export const CONCAT_VIDEO_COMMAND = "pnpm run concat-video";

export type SceneChunkReport = {
  slideNumber: number;
  file: string;
  byteLength: number;
  from: number;
  to: number;
  reused: boolean;
};

/**
 * Parse the single JSON line `scripts/render-scene.mjs` prints.
 *
 * A chunk that cannot be confirmed is treated as absent: the concat step would
 * fail on it anyway, and failing here means the remaining scenes are never
 * rendered for nothing.
 */
export function parseSceneChunkReport(
  stdout: string | undefined,
  expectedSlideNumber: number,
): SceneChunkReport | null {
  if (!stdout) {
    return null;
  }
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"render-scene"')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.ok !== true ||
      record.slideNumber !== expectedSlideNumber ||
      typeof record.file !== "string" ||
      typeof record.byteLength !== "number" ||
      typeof record.from !== "number" ||
      typeof record.to !== "number" ||
      record.byteLength <= 0 ||
      record.to < record.from
    ) {
      return null;
    }
    return {
      slideNumber: expectedSlideNumber,
      file: record.file,
      byteLength: record.byteLength,
      from: Math.round(record.from),
      to: Math.round(record.to),
      reused: record.reused === true,
    };
  }
  return null;
}

/**
 * Parse the single JSON line `scripts/concat-video.mjs` prints. Anything the
 * script did not emit exactly (partial output, an interleaved renderer log
 * line, a truncated stdout) yields null rather than a half-populated report.
 */
export function parseRenderVideoReport(
  stdout: string | undefined,
): RenderVideoReport | null {
  if (!stdout) {
    return null;
  }
  // The renderer writes progress to stdout as well, so scan for the last line
  // that parses as our report object instead of assuming a clean stdout.
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"render-video"')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.ok !== true ||
      typeof record.file !== "string" ||
      typeof record.byteLength !== "number" ||
      typeof record.durationInFrames !== "number" ||
      typeof record.fps !== "number" ||
      typeof record.width !== "number" ||
      typeof record.height !== "number"
    ) {
      return null;
    }
    if (
      record.byteLength <= 0 ||
      record.durationInFrames <= 0 ||
      record.fps <= 0 ||
      record.width <= 0 ||
      record.height <= 0
    ) {
      return null;
    }
    return {
      file: record.file,
      byteLength: record.byteLength,
      durationInFrames: Math.round(record.durationInFrames),
      fps: Math.round(record.fps),
      width: Math.round(record.width),
      height: Math.round(record.height),
      hasAudio: record.hasAudio === true,
    };
  }
  return null;
}

/** Sandbox path of the rendered mp4 for a project rooted at `root`. */
export function renderedVideoSandboxPath(root: string) {
  return `${root}/${PROJECT_RENDERED_VIDEO_PATH}`;
}

/** File name the mp4 is stored and served under. */
export function renderedVideoFileName(
  payload: VideoPresentationProjectPayload,
) {
  return `${safeStorageSegment(payload.project.title)}${RENDERED_VIDEO_EXTENSION}`;
}

/**
 * Store a rendered mp4 as an artifact asset.
 *
 * Deliberately the same write path the narration tracks and the cover still
 * already use — `buildArtifactStorageKey` + `storage.upload` — so the mp4 is
 * served by the existing `/artifacts/:id/assets/:fileName` route and no second
 * storage mechanism enters the codebase. Returns the record a payload would
 * carry under `renderedVideo`; nothing persists it yet.
 */
export async function uploadRenderedVideo(input: {
  artifactId: string;
  payload: VideoPresentationProjectPayload;
  report: RenderVideoReport;
  storage: ArtifactStorage;
  video: Uint8Array;
  workspaceId: string;
}): Promise<VideoPresentationRenderedVideo | null> {
  if (
    input.video.byteLength <= 0 ||
    input.video.byteLength > MAX_STORED_VIDEO_BYTES
  ) {
    return null;
  }
  const fileName = renderedVideoFileName(input.payload);
  const storageKey = input.storage.buildArtifactStorageKey({
    artifactId: input.artifactId,
    fileName,
    workspaceId: input.workspaceId,
  });
  await input.storage.upload({
    body: input.video,
    contentType: RENDERED_VIDEO_MIME_TYPE,
    key: storageKey,
  });
  return {
    assetUrl: artifactAssetUrl({
      artifactId: input.artifactId,
      fileName,
      workspaceId: input.workspaceId,
    }),
    byteLength: input.video.byteLength,
    durationInFrames: input.report.durationInFrames,
    fileName,
    fps: input.report.fps,
    hasAudio: input.report.hasAudio,
    height: input.report.height,
    mimeType: RENDERED_VIDEO_MIME_TYPE,
    storageBucket: input.storage.getBucketName(),
    storageKey,
    width: input.report.width,
  };
}
