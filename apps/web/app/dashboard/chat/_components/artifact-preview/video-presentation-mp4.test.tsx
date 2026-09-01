// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { test } from "vitest";
import { VideoPresentationPreview } from "@sourceweft/builtin-tool-video-presentation/ui";

test("plays and downloads only the trusted exact-version MP4", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const videoUrl =
    "/api/artifact-file?workspaceId=workspace-1&artifactId=artifact-1&artifactVersionId=version-1&versionMedia=video";
  const coverUrl = videoUrl.replace("versionMedia=video", "versionMedia=cover");

  await act(async () => {
    root.render(
      createElement(VideoPresentationPreview, {
        payload: {
          artifactId: "artifact-1",
          artifactVersionId: "version-1",
          artifactType: "video_presentation",
          title: "Trusted video",
          description: null,
          durationSeconds: 10,
          media: {
            url: videoUrl,
            downloadUrl: `${videoUrl}&download=1`,
            contentType: "video/mp4",
            fileName: "trusted.mp4",
            byteLength: 1024,
            width: 1920,
            height: 1080,
            fps: 30,
            hasAudio: true,
          },
          coverImage: {
            url: coverUrl,
            contentType: "image/jpeg",
            fileName: "cover.jpg",
            byteLength: 128,
            width: 1920,
            height: 1080,
          },
        },
        title: "Trusted video",
      }),
    );
  });

  const video = container.querySelector("video");
  assert.ok(video);
  assert.equal(video.getAttribute("src"), videoUrl);
  assert.equal(video.getAttribute("poster"), coverUrl);
  assert.equal(container.querySelector("iframe"), null);
  assert.match(
    container.querySelector("a")?.getAttribute("href") ?? "",
    /artifactVersionId=version-1/u,
  );

  await act(async () => root.unmount());
  container.remove();
});

test("does not fall back to scene source when exact-version media is missing", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(VideoPresentationPreview, {
        payload: {
          sceneModules: [{ code: "export const VideoScene = () => null" }],
        },
        title: "Unavailable video",
      }),
    );
  });

  assert.equal(container.querySelector("video"), null);
  assert.equal(container.querySelector("iframe"), null);
  assert.match(container.textContent ?? "", /unavailable/iu);

  await act(async () => root.unmount());
  container.remove();
});
