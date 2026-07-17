import { describe, expect, it } from "vitest";
import {
  canRenderVideoPresentationScenes,
  isVideoPresentationFailed,
  resolveVideoProjectStageLabel,
} from "./video-presentation-preview";

describe("video presentation preview adapter", () => {
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
    ).toBe("Typechecking generated project");
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
    ).toBe("Finalizing video project");
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
