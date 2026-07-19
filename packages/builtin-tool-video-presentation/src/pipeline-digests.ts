import {
  truncatePipelineDisplay,
  truncatePipelineSummary,
  type ArtifactPipelineStepPatch,
} from "@sourceweft/contracts/artifact-pipeline";
import type {
  VideoPresentationPipelineStageId,
  VideoPresentationProjectPayload,
} from "@sourceweft/contracts/video-presentation";

export type VideoPresentationStageView = ArtifactPipelineStepPatch;

function slideTitles(payload: VideoPresentationProjectPayload) {
  return payload.slides.map((slide) => slide.title.trim()).filter(Boolean);
}

function slideSynopsis(slide: VideoPresentationProjectPayload["slides"][number]) {
  if (typeof slide.subtitle === "string" && slide.subtitle.trim()) {
    return slide.subtitle.trim().slice(0, 120);
  }
  if (typeof slide.contentMarkdown === "string" && slide.contentMarkdown.trim()) {
    const fromMarkdown = slide.contentMarkdown
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (fromMarkdown) {
      return fromMarkdown.slice(0, 120);
    }
  }
  if (Array.isArray(slide.speakerTranscript) && slide.speakerTranscript[0]) {
    return slide.speakerTranscript[0].trim().slice(0, 120);
  }
  return "";
}

function buildStoryboardDisplay(payload: VideoPresentationProjectPayload) {
  const lines = payload.slides.map((slide, index) => {
    const synopsis = slideSynopsis(slide);
    return synopsis
      ? `${index + 1}. **${slide.title}** — ${synopsis}`
      : `${index + 1}. **${slide.title}**`;
  });
  return truncatePipelineDisplay(
    [`# Storyboard · ${payload.project.title}`, "", ...lines].join("\n"),
  );
}

function buildThemesDisplay(payload: VideoPresentationProjectPayload) {
  const assignments = payload.themeAssignments ?? [];
  if (assignments.length === 0) {
    return truncatePipelineDisplay("No theme assignments yet.");
  }
  const lines = assignments.map(
    (item) =>
      `- Slide ${item.slideNumber}: **${item.themeName}** (${item.mode})`,
  );
  return truncatePipelineDisplay(
    ["# Slide themes", "", ...lines].join("\n"),
  );
}

function buildAudioDisplay(payload: VideoPresentationProjectPayload) {
  const tracks = payload.audioTracks ?? [];
  if (tracks.length === 0) {
    return truncatePipelineDisplay("Narration disabled or no tracks generated.");
  }
  const totalSec = tracks.reduce(
    (sum, track) => sum + (typeof track.durationSeconds === "number" ? track.durationSeconds : 0),
    0,
  );
  const lines = tracks.map(
    (track, index) =>
      `- Track ${index + 1}${track.fileName ? ` · ${track.fileName}` : ""}${
        typeof track.durationSeconds === "number"
          ? ` · ${track.durationSeconds.toFixed(1)}s`
          : ""
      }`,
  );
  return truncatePipelineDisplay(
    [
      `# Narration audio · ${tracks.length} tracks · ${totalSec.toFixed(1)}s`,
      "",
      ...lines,
    ].join("\n"),
  );
}

function buildSceneModulesDisplay(payload: VideoPresentationProjectPayload) {
  const modules = payload.sceneModules ?? [];
  if (modules.length === 0) {
    return truncatePipelineDisplay("No scene modules yet.");
  }
  const ok = modules.filter(
    (mod) =>
      mod.compileStatus === "compiled" || mod.compileStatus === "repaired",
  ).length;
  const failed = modules.filter((mod) => mod.compileStatus === "failed").length;
  const lines = modules.map(
    (mod) =>
      `- ${mod.title ?? `Scene ${mod.slideNumber ?? "?"}`}: ${mod.compileStatus ?? "unknown"}${
        mod.diagnostics?.length ? ` · ${mod.diagnostics[0]}` : ""
      }`,
  );
  return truncatePipelineDisplay(
    [
      `# Scene modules · ${ok} ok · ${failed} failed`,
      "",
      ...lines.slice(0, 40),
      ...(lines.length > 40 ? [`…and ${lines.length - 40} more`] : []),
    ].join("\n"),
  );
}

function sandboxLogTail(
  block:
    | { stdout?: string; stderr?: string; diagnostics?: string[] }
    | undefined,
) {
  if (!block) {
    return undefined;
  }
  const lines: string[] = [];
  if (Array.isArray(block.diagnostics)) {
    lines.push(...block.diagnostics);
  }
  if (typeof block.stdout === "string" && block.stdout.trim()) {
    lines.push(...block.stdout.trim().split("\n").slice(-12));
  }
  if (typeof block.stderr === "string" && block.stderr.trim()) {
    lines.push(...block.stderr.trim().split("\n").slice(-12));
  }
  return lines.length > 0 ? lines : undefined;
}

/**
 * Build user-visible stage summary/display/I/O for COT from the current payload.
 */
export function buildVideoPresentationStageView(
  stageId: VideoPresentationPipelineStageId,
  payload: VideoPresentationProjectPayload,
): VideoPresentationStageView {
  switch (stageId) {
    case "planning_storyboard": {
      const titles = slideTitles(payload);
      return {
        summary: truncatePipelineSummary(
          `Planned ${payload.slides.length} slides · ${payload.project.title}`,
        ),
        display: buildStoryboardDisplay(payload),
        input: {
          title: payload.project.title,
          slideCount: payload.slides.length,
          stylePreset: payload.project.stylePreset,
        },
        output: {
          slideCount: payload.slides.length,
          titles: titles.slice(0, 24),
        },
        metrics: { slideCount: payload.slides.length },
      };
    }
    case "materializing_assets": {
      const assets = payload.assets ?? [];
      return {
        summary: truncatePipelineSummary(
          `Prepared ${assets.length} visual asset${assets.length === 1 ? "" : "s"}`,
        ),
        display: truncatePipelineDisplay(
          [
            `# Visual assets · ${assets.length}`,
            "",
            ...assets.slice(0, 40).map(
              (asset) =>
                `- ${asset.assetId ?? "asset"}${asset.type ? ` · ${asset.type}` : ""}`,
            ),
          ].join("\n"),
        ),
        input: { slideCount: payload.slides.length },
        output: { assetCount: assets.length },
        metrics: { assetCount: assets.length },
      };
    }
    case "generating_audio_tracks": {
      const tracks = payload.audioTracks ?? [];
      const totalSec = tracks.reduce(
        (sum, track) =>
          sum +
          (typeof track.durationSeconds === "number" ? track.durationSeconds : 0),
        0,
      );
      return {
        summary: truncatePipelineSummary(
          tracks.length === 0
            ? "Narration skipped"
            : `Generated ${tracks.length} audio tracks · ${totalSec.toFixed(1)}s`,
        ),
        display: buildAudioDisplay(payload),
        input: {
          narrationEnabled: tracks.length > 0,
          slideCount: payload.slides.length,
        },
        output: {
          trackCount: tracks.length,
          totalDurationSec: Number(totalSec.toFixed(2)),
        },
        metrics: {
          trackCount: tracks.length,
          totalDurationSec: Number(totalSec.toFixed(2)),
        },
      };
    }
    case "assigning_slide_themes": {
      const assignments = payload.themeAssignments ?? [];
      return {
        summary: truncatePipelineSummary(
          `Assigned themes to ${assignments.length} slides`,
        ),
        display: buildThemesDisplay(payload),
        input: { slideCount: payload.slides.length },
        output: {
          assignmentCount: assignments.length,
          themes: assignments.map((item) => ({
            slideNumber: item.slideNumber,
            themeName: item.themeName,
            mode: item.mode,
          })),
        },
        metrics: { assignmentCount: assignments.length },
      };
    }
    case "generating_scene_modules": {
      const modules = payload.sceneModules ?? [];
      const compileOk = modules.filter(
        (mod) =>
          mod.compileStatus === "compiled" ||
          mod.compileStatus === "repaired",
      ).length;
      const compileFailed = modules.filter(
        (mod) => mod.compileStatus === "failed",
      ).length;
      return {
        summary: truncatePipelineSummary(
          `Generated ${modules.length} scene modules · ${compileOk} ok`,
        ),
        display: buildSceneModulesDisplay(payload),
        input: {
          slideCount: payload.slides.length,
          themeCount: payload.themeAssignments?.length ?? 0,
        },
        output: {
          moduleCount: modules.length,
          compileOk,
          compileFailed,
        },
        metrics: { moduleCount: modules.length, compileOk, compileFailed },
        logTail: modules
          .flatMap((mod) => mod.diagnostics ?? [])
          .slice(0, 20),
      };
    }
    case "repairing_scene_modules": {
      const modules = payload.sceneModules ?? [];
      const repaired = modules.filter((mod) => mod.compileStatus === "repaired").length;
      const stillFailed = modules.filter(
        (mod) => mod.compileStatus === "failed",
      ).length;
      return {
        summary: truncatePipelineSummary(
          `Repaired ${repaired} · ${stillFailed} still failing`,
        ),
        display: buildSceneModulesDisplay(payload),
        input: {
          failedBefore: modules.filter((mod) => (mod.repairAttempts ?? 0) > 0)
            .length,
        },
        output: { repaired, stillFailed },
        metrics: { repaired, stillFailed },
        logTail: modules
          .flatMap((mod) => mod.diagnostics ?? [])
          .slice(0, 20),
      };
    }
    case "installing_project": {
      const install = payload.projectCode?.install;
      const ok = install?.ok === true;
      return {
        summary: truncatePipelineSummary(
          ok ? "Dependencies installed" : "Install finished with issues",
        ),
        display: truncatePipelineDisplay(
          ok
            ? "Project dependencies installed successfully."
            : [
                "Install reported problems.",
                ...(install?.diagnostics ?? []).slice(0, 12),
              ].join("\n"),
        ),
        input: {
          fileCount: payload.projectCode?.files?.length ?? 0,
        },
        output: { ok, diagnostics: install?.diagnostics?.slice(0, 12) },
        logTail: sandboxLogTail(install),
        metrics: { ok: ok ? 1 : 0 },
      };
    }
    case "typechecking_project": {
      const typecheck = payload.projectCode?.typecheck;
      const ok = typecheck?.ok === true;
      return {
        summary: truncatePipelineSummary(
          ok ? "Typecheck passed" : "Typecheck reported errors",
        ),
        display: truncatePipelineDisplay(
          [
            ok
              ? "Typecheck passed (from project sandbox run)."
              : "Typecheck reported errors (from project sandbox run).",
            ...(typecheck?.diagnostics ?? []).slice(0, 16),
          ].join("\n"),
        ),
        output: { ok, diagnostics: typecheck?.diagnostics?.slice(0, 12) },
        logTail: sandboxLogTail(typecheck),
        metrics: { ok: ok ? 1 : 0 },
      };
    }
    case "rendering_smoke_preview": {
      const smoke = payload.projectCode?.smoke;
      const ok = smoke?.ok === true;
      return {
        summary: truncatePipelineSummary(
          ok ? "Smoke preview ok" : "Smoke preview failed",
        ),
        display: truncatePipelineDisplay(
          [
            ok
              ? "Smoke preview succeeded (from project sandbox run)."
              : "Smoke preview failed (from project sandbox run).",
            ...(smoke?.diagnostics ?? []).slice(0, 16),
          ].join("\n"),
        ),
        output: { ok },
        logTail: sandboxLogTail(smoke),
        metrics: { ok: ok ? 1 : 0 },
      };
    }
    case "verifying_visual_quality": {
      const scenesWithFindings = (payload.sceneModules ?? []).filter((scene) =>
        (scene.layoutWarnings ?? []).some((warning) =>
          warning.startsWith("Visual QA"),
        ),
      );
      const repairedScenes = (payload.sceneModules ?? []).filter(
        (scene) => scene.compileStatus === "repaired",
      );
      return {
        summary: truncatePipelineSummary(
          scenesWithFindings.length === 0
            ? "Rendered slides reviewed · no defects"
            : `Rendered slides reviewed · ${scenesWithFindings.length} slide(s) flagged`,
        ),
        display: truncatePipelineDisplay(
          [
            "Rendered one frame per slide and reviewed it with the vision model.",
            scenesWithFindings.length === 0
              ? "No cut-off, overflow, overlap, or contrast defects found."
              : `Flagged slides: ${scenesWithFindings
                  .map((scene) => scene.slideNumber)
                  .join(", ")}.`,
            ...(repairedScenes.length > 0
              ? [`Repaired scenes: ${repairedScenes.length}.`]
              : []),
          ].join("\n"),
        ),
        output: {
          flaggedSlideCount: scenesWithFindings.length,
          repairedSceneCount: repairedScenes.length,
        },
        metrics: { flaggedSlideCount: scenesWithFindings.length },
      };
    }
    case "publishing_video_project": {
      const duration = payload.project.durationSeconds ?? 0;
      return {
        summary: truncatePipelineSummary(
          `Published · ${duration.toFixed(1)}s · ${payload.slides.length} slides`,
        ),
        display: truncatePipelineDisplay(
          [
            `# Published · ${payload.project.title}`,
            "",
            `- Duration: ${duration.toFixed(1)}s`,
            `- Slides: ${payload.slides.length}`,
            `- Style: ${payload.project.stylePreset}`,
          ].join("\n"),
        ),
        input: {
          slideCount: payload.slides.length,
          sceneCount: payload.sceneModules?.length ?? 0,
        },
        output: {
          durationSeconds: duration,
          slideCount: payload.slides.length,
          previewReady: true,
        },
        metrics: {
          durationSeconds: duration,
          slideCount: payload.slides.length,
        },
      };
    }
  }
}
