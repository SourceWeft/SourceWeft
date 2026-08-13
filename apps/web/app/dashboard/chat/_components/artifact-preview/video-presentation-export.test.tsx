// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, test, vi } from "vitest";
import type { VideoPresentationProjectPayload } from "@sourceweft/contracts/video-presentation";
import { createPlaceholderCompiledScenes } from "@sourceweft/video-presentation-runtime";
import { VideoPresentationExportControls } from "@sourceweft/builtin-tool-video-presentation/ui";

vi.mock("@remotion/web-renderer", () => ({
  canRenderMediaOnWeb: vi.fn().mockResolvedValue({ canRender: true }),
  // Keep the render pending so the in-progress UI stays mounted under test.
  renderMediaOnWeb: vi.fn().mockReturnValue(new Promise(() => {})),
}));

const payload: VideoPresentationProjectPayload = {
  schemaVersion: 2,
  kind: "video_presentation",
  generation: {
    status: "ready",
    stage: "ready",
    progress: 100,
  },
  project: {
    title: "Black Hole",
    fps: 30,
    width: 1920,
    height: 1080,
    durationSeconds: 3,
    stylePreset: "cinematic",
    globalVisualDirection: "Test direction",
  },
  slides: [
    {
      slideNumber: 1,
      title: "Scene One",
      speakerTranscript: ["Hello"],
      sceneIntent: "Show a scene",
      assetRefs: [],
      assetNeeds: [],
    },
  ],
  audioTracks: [],
  sceneModules: [
    {
      slideNumber: 1,
      title: "Scene One",
      componentName: "VideoScene",
      code: "export default function VideoScene() { return null; }",
      durationInFrames: 90,
      repairAttempts: 0,
      diagnostics: [],
      layoutWarnings: [],
      compileStatus: "compiled",
    },
  ],
  assets: [],
  preview: {
    slideCount: 1,
    durationSeconds: 3,
  },
  renderProfile: {
    stylePreset: "cinematic",
    visualDensity: "balanced",
    durationTarget: "short",
    language: "en-US",
  },
  themeAssignments: [],
  sourceDigest: "Test digest",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderExportControls() {
  container = document.createElement("div");
  document.body.append(container);
  const createdRoot = createRoot(container);
  root = createdRoot;

  await act(async () => {
    createdRoot.render(
      createElement(VideoPresentationExportControls, {
        canExport: true,
        payload,
        scenes: createPlaceholderCompiledScenes(payload),
        title: "Black Hole",
      }),
    );
  });

  return container;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

test("shows the leaving warning while the in-browser render is running", async () => {
  const element = await renderExportControls();

  const downloadButton = [...element.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Download Video"),
  );
  assert.ok(downloadButton);

  await act(async () => {
    downloadButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.match(element.textContent ?? "", /Rendering MP4/);
  assert.match(
    element.textContent ?? "",
    /Closing, refreshing, or leaving this page cancels the render\./,
  );
  assert.ok(
    [...element.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("Cancel"),
    ),
  );
});
