// @vitest-environment jsdom

import assert from "node:assert/strict";
import { createElement } from "react";
import { afterEach, test } from "vitest";
import { VideoPresentationExportControls } from "@sourceweft/builtin-tool-video-presentation/ui";
import { mount, unmountAll } from "@/test/react";

afterEach(unmountAll);

test("downloads the already-rendered MP4 without starting a browser render", async () => {
  const { container } = await mount(
    createElement(VideoPresentationExportControls, {
      downloadUrl:
        "/api/artifact-file?workspaceId=workspace-1&artifactId=artifact-1&artifactVersionId=version-1&versionMedia=video&download=1",
      title: "Black Hole",
    }),
  );

  const link = container.querySelector("a");
  assert.ok(link);
  assert.equal(link.textContent?.trim(), "Download Video");
  assert.equal(link.getAttribute("download"), "Black Hole.mp4");
  assert.match(link.getAttribute("href") ?? "", /artifactVersionId=version-1/u);
  assert.doesNotMatch(container.textContent ?? "", /Rendering|Cancel/u);
});
