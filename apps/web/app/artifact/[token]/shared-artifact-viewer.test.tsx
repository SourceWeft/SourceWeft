// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { test } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { SharedArtifactViewer } from "./shared-artifact-viewer";
import messages from "../../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];

test("public share uses the version-pinned attachment URL for download", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const fileUrl =
    "https://api.test/v1/public/shares/token/versions/version-1/media/video";
  const downloadUrl = `${fileUrl}?download=1`;
  const previewImageUrl = fileUrl.replace("/video", "/cover");

  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={intlMessages}>
        <SharedArtifactViewer
          artifact={{
            token: "token",
            artifactType: "video_presentation",
            title: "Shared video",
            fileUrl,
            downloadUrl,
            inlinePreviewable: true,
            previewImageUrl,
            payload: null,
            description: null,
            viewCount: 0,
            noindex: false,
            createdAt: "2026-08-31T00:00:00.000Z",
          }}
        />
      </NextIntlClientProvider>,
    );
  });

  assert.equal(
    container.querySelector(`a[href="${downloadUrl}"]`)?.getAttribute("href"),
    downloadUrl,
  );
  assert.equal(
    container.querySelector("video")?.getAttribute("poster"),
    previewImageUrl,
  );

  await act(async () => root.unmount());
  container.remove();
});
