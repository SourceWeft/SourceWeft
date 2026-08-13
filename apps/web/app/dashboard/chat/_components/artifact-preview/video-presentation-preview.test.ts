import { describe, expect, it } from "vitest";
import {
  canRenderVideoPresentationScenes,
  hasVideoPresentationRenderedVideo,
  isVideoPresentationFailed,
  resolveVideoProjectStageLabel,
} from "@sourceweft/builtin-tool-video-presentation/ui";

describe("video presentation capability ui", () => {
  it("labels current worker stages", () => {
    expect(
      resolveVideoProjectStageLabel({
        generation: { stage: "generating_project_code" },
      }),
    ).toBe("Generating Remotion project code");
    expect(
      resolveVideoProjectStageLabel({
        generation: { stage: "installing_project" },
      }),
    ).toBe("Installing project dependencies");
    expect(
      resolveVideoProjectStageLabel({
        generation: { stage: "typechecking_project" },
      }),
    ).toBe("Typechecking project");
    expect(
      resolveVideoProjectStageLabel({
        generation: { stage: "rendering_smoke_preview" },
      }),
    ).toBe("Rendering smoke preview");
    expect(
      resolveVideoProjectStageLabel({
        generation: { stage: "planning_storyboard" },
      }),
    ).toBe("Planning storyboard");
    expect(
      resolveVideoProjectStageLabel({
        generation: { stage: "generating_scene_modules" },
      }),
    ).toBe("Generating Remotion scene code");
    expect(
      resolveVideoProjectStageLabel({
        generation: { stage: "repairing_scene_modules" },
      }),
    ).toBe("Repairing scene code");
    expect(
      resolveVideoProjectStageLabel({
        generation: { stage: "publishing_video_project" },
      }),
    ).toBe("Publishing video project");
  });

  // The cross-surface wording regression (preview panel vs message trace) is
  // asserted where the words are owned:
  // packages/builtin-tool-video-presentation/tests/stage-labels.test.ts.
  it("falls back to the capability's own preparing copy", () => {
    expect(resolveVideoProjectStageLabel({})).toBe("Preparing video project");
  });

  it("only allows render/export when all generated scenes compiled cleanly", () => {
    expect(
      canRenderVideoPresentationScenes({
        compiledSceneCount: 2,
        diagnosticCount: 0,
        isCompilingScenes: false,
        isPreparing: false,
        sceneModuleCount: 2,
        slideCount: 2,
      }),
    ).toBe(true);
    expect(
      canRenderVideoPresentationScenes({
        compiledSceneCount: 2,
        diagnosticCount: 1,
        isCompilingScenes: false,
        isPreparing: false,
        sceneModuleCount: 2,
        slideCount: 2,
      }),
    ).toBe(false);
    expect(
      canRenderVideoPresentationScenes({
        compiledSceneCount: 2,
        diagnosticCount: 0,
        isCompilingScenes: false,
        isPreparing: false,
        sceneModuleCount: 0,
        slideCount: 2,
      }),
    ).toBe(false);
  });

  it("offers the toolbar download only when a server-rendered mp4 is stored", () => {
    // Sandbox render path: a real mp4 the host can serve on the file route.
    expect(
      hasVideoPresentationRenderedVideo({
        renderedVideo: {
          fileName: "deck.mp4",
          storageKey: "workspaces/w1/artifacts/a1/deck.mp4",
        },
      }),
    ).toBe(true);
    // Browser-compiled path: no server file, only the in-preview client render.
    expect(
      hasVideoPresentationRenderedVideo({ videoDownloadOnly: true }),
    ).toBe(false);
    // A malformed/partial renderedVideo is not servable, so no download.
    expect(
      hasVideoPresentationRenderedVideo({ renderedVideo: { fileName: "" } }),
    ).toBe(false);
  });

  it("treats failed artifact or failed payload as terminal failure", () => {
    expect(
      isVideoPresentationFailed({
        artifactStatus: "ready",
        payload: { generation: { status: "failed" } },
      }),
    ).toBe(true);
    expect(
      isVideoPresentationFailed({
        artifactStatus: "failed",
        payload: { generation: { status: "running" } },
      }),
    ).toBe(true);
    expect(
      isVideoPresentationFailed({
        artifactStatus: "running",
        payload: { generation: { status: "running" } },
      }),
    ).toBe(false);
  });
});
