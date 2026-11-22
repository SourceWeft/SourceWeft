// @vitest-environment jsdom

import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { tableArtifactViewHandlers } from "@sourceweft/builtin-tool-table";
import { TABLE_FIXTURE_EN } from "@sourceweft/builtin-tool-table/testing";
import { studyArtifactViewHandlers } from "@sourceweft/builtin-tool-study";
import {
  flashcardsFixtureEn,
  quizFixtureEn,
} from "@sourceweft/builtin-tool-study/testing";
import { SharedArtifactViewer } from "./shared-artifact-viewer";
import { buttons, click, flush, mountWithIntl, unmountAll } from "@/test/react";

vi.mock("@sourceweft/preview/react", () => ({
  Preview: ({
    source,
  }: {
    source: { name: string; mimeType?: string; url: string };
  }) => (
    <div
      data-testid="medium-preview"
      data-name={source.name}
      data-mime={source.mimeType}
      data-url={source.url}
    />
  ),
}));

test("public share uses the version-pinned attachment URL for download", async () => {
  const fileUrl =
    "https://api.test/v1/public/shares/token/versions/version-1/media/video";
  const downloadUrl = `${fileUrl}?download=1`;
  const previewImageUrl = fileUrl.replace("/video", "/cover");

  const { container } = await mountWithIntl(
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
    />,
  );

  assert.equal(
    container.querySelector(`a[href="${downloadUrl}"]`)?.getAttribute("href"),
    downloadUrl,
  );
  assert.equal(
    container.querySelector("video")?.getAttribute("poster"),
    previewImageUrl,
  );

  await unmountAll();
});

test("ordinary shared files expose version-pinned deliverables and hide private authoring files", async () => {
  const { container } = await mountWithIntl(
    <SharedArtifactViewer
      artifact={{
        token: "token",
        artifactType: "file" as const,
        title: "Report",
        fileUrl: null,
        downloadUrl: null,
        inlinePreviewable: false,
        previewImageUrl: null,
        payload: {
          versionFiles: [
            {
              fileName: "report.docx",
              role: "primary",
              downloadUrl:
                "/public/report.docx?artifactVersionId=v2&download=1",
            },
            {
              fileName: "report.pdf",
              role: "asset",
              downloadUrl: "/public/report.pdf?artifactVersionId=v2&download=1",
            },
            {
              fileName: "source.json",
              role: "source",
              access: "private",
              downloadUrl: "/private-source",
            },
          ],
        },
        description: null,
        viewCount: 0,
        noindex: false,
        createdAt: "2026-10-16T00:00:00.000Z",
      }}
    />,
  );
  assert.equal(
    container
      .querySelector('a[aria-label="Download report.pdf"]')
      ?.getAttribute("href"),
    "/public/report.pdf?artifactVersionId=v2&download=1",
  );
  assert.equal(
    container
      .querySelector('a[aria-label="Download report.docx"]')
      ?.getAttribute("href"),
    "/public/report.docx?artifactVersionId=v2&download=1",
  );
  assert.doesNotMatch(container.textContent ?? "", /source.json/);
  await unmountAll();
});

test("public fallback uses primary file metadata rather than the display title", async () => {
  const artifact = {
    token: "token",
    artifactType: "file" as const,
    title: "report.md",
    fileUrl: "/public/exact?v=2",
    downloadUrl: null,
    inlinePreviewable: true,
    previewImageUrl: null,
    payload: {
      versionFiles: [
        {
          fileName: "report.pdf",
          role: "primary",
          url: "/public/exact?v=2",
          contentType: "application/pdf",
        },
      ],
    },
    description: null,
    viewCount: 0,
    noindex: false,
    createdAt: "2026-10-16T00:00:00.000Z",
  };
  const { container } = await mountWithIntl(
    <SharedArtifactViewer artifact={artifact} />,
  );
  const preview = container.querySelector('[data-testid="medium-preview"]')!;
  assert.equal(preview.getAttribute("data-name"), "report.pdf");
  assert.equal(preview.getAttribute("data-mime"), "application/pdf");
  assert.equal(preview.getAttribute("data-url"), "/public/exact?v=2");
  await unmountAll();
  const legacy = await mountWithIntl(
    <SharedArtifactViewer artifact={{ ...artifact, payload: null }} />,
  );
  assert.equal(
    legacy.container
      .querySelector('[data-testid="medium-preview"]')
      ?.getAttribute("data-name"),
    "report.md",
  );
  await unmountAll();
});

test("a shared table renders its stripped public payload with values and no source quote", async () => {
  const [handler] = tableArtifactViewHandlers;
  const payload = handler!.buildPublicPayload!({
    artifact: {
      artifactType: "table",
      status: "ready",
      title: "Trials",
      storageBucket: null,
      storageKey: null,
      payloadJson: TABLE_FIXTURE_EN,
    },
    assetUrl: (fileName) => `/public/${fileName}`,
  });
  assert.ok(payload);
  assert.doesNotMatch(JSON.stringify(payload), /"quote"/);

  const { container } = await mountWithIntl(
    <SharedArtifactViewer
      artifact={{
        token: "token",
        artifactType: "table",
        title: "Trials",
        fileUrl: null,
        downloadUrl: null,
        inlinePreviewable: false,
        previewImageUrl: null,
        payload,
        description: null,
        viewCount: 0,
        noindex: false,
        createdAt: "2026-11-21T00:00:00.000Z",
      }}
    />,
  );
  const text = container.textContent ?? "";
  // Values, column names and source titles render.
  for (const shown of [
    "Atlas trial report",
    "Beacon cohort study",
    "Study design",
    "Randomised controlled trial",
    "1,200 participants",
  ]) {
    assert.ok(text.includes(shown), `missing "${shown}"`);
  }
  // Wording comes from the catalog, not raw keys.
  assert.ok(text.includes("Not mentioned"));
  assert.doesNotMatch(text, /table\.cell\./);
  // No quote, and nothing that would open one.
  assert.doesNotMatch(text, /This was a randomised controlled trial/);
  assert.equal(container.querySelector("[data-study-evidence]"), null);
  await unmountAll();
});

function sharedStudy(
  artifactType: "flashcards" | "quiz" | "mindmap",
  payload: Record<string, unknown>,
) {
  return {
    token: "token",
    artifactType,
    title: "Photosynthesis",
    fileUrl: null,
    downloadUrl: null,
    inlinePreviewable: false,
    previewImageUrl: null,
    payload,
    description: null,
    viewCount: 0,
    noindex: false,
    createdAt: "2026-11-22T00:00:00.000Z",
  };
}

function publicStudyPayload(artifactType: "flashcards" | "quiz", payloadJson: unknown) {
  const handler = studyArtifactViewHandlers.find(
    (candidate) => candidate.artifactType === artifactType,
  );
  const payload = handler!.buildPublicPayload!({
    artifact: {
      artifactType,
      status: "ready",
      title: "Photosynthesis",
      storageBucket: null,
      storageKey: null,
      payloadJson,
    },
    assetUrl: (fileName) => `/public/${fileName}`,
  });
  assert.ok(payload);
  return payload;
}

test("shared flashcards render the stripped public payload with catalog wording and no source quote", async () => {
  const payload = publicStudyPayload("flashcards", flashcardsFixtureEn);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /"quote"/);
  assert.doesNotMatch(serialized, /"chunkId"/);

  const { container } = await mountWithIntl(
    <SharedArtifactViewer artifact={sharedStudy("flashcards", payload)} />,
  );
  await flush(3);
  const text = container.textContent ?? "";
  assert.ok(text.includes("What does photosynthesis produce?"));
  // Wording comes from the catalog, not raw keys.
  assert.ok(text.includes("Export for Anki (CSV)"));
  assert.ok(text.includes("1 / 3"));
  assert.doesNotMatch(text, /study\./);
  // Read-only: no review mode, no grading, no evidence.
  assert.equal(buttons("Review", container).length, 0);
  assert.equal(container.querySelector("[data-study-evidence]"), null);
  assert.doesNotMatch(text, /Photosynthesis turns carbon dioxide/);
  await unmountAll();
});

test("a shared quiz is answered in the page with catalog wording", async () => {
  const payload = publicStudyPayload("quiz", quizFixtureEn);
  assert.doesNotMatch(JSON.stringify(payload), /"quote"|"chunkId"/);

  const { container } = await mountWithIntl(
    <SharedArtifactViewer artifact={sharedStudy("quiz", payload)} />,
  );
  await flush(3);
  assert.ok((container.textContent ?? "").includes("4 questions."));
  await click(buttons("Start", container)[0]!);
  await flush(3);
  const text = container.textContent ?? "";
  assert.ok(text.includes("Question 1 of 4"));
  assert.ok(text.includes("Which gas do plants release during photosynthesis?"));
  assert.doesNotMatch(text, /study\./);
  await unmountAll();
});
