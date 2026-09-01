// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { test } from "vitest";
import { VideoPresentationExportControls } from "@sourceweft/builtin-tool-video-presentation/ui";

test("downloads the already-rendered MP4 without starting a browser render", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(VideoPresentationExportControls, {
        downloadUrl:
          "/api/artifact-file?workspaceId=workspace-1&artifactId=artifact-1&artifactVersionId=version-1&versionMedia=video&download=1",
        title: "Black Hole",
      }),
    );
  });

  const link = container.querySelector("a");
  assert.ok(link);
  assert.equal(link.textContent?.trim(), "Download Video");
  assert.equal(link.getAttribute("download"), "Black Hole.mp4");
  assert.match(link.getAttribute("href") ?? "", /artifactVersionId=version-1/u);
  assert.doesNotMatch(container.textContent ?? "", /Rendering|Cancel/u);

  await act(async () => root.unmount());
  container.remove();
});
