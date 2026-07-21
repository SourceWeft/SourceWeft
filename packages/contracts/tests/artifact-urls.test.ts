import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTIFACT_FILE_PROXY_ROUTE,
  ARTIFACT_PREVIEW_PAGE_ROUTE,
  buildArtifactAssetUrl,
  buildArtifactDownloadUrl,
  buildArtifactPreviewImageUrl,
  buildArtifactPreviewUrl,
  buildArtifactProxyUrl,
  buildArtifactRestUrl,
  buildArtifactSourceJsonUrl,
  isSafeFlatArtifactAssetFileName,
} from "../src/artifact-urls";

/**
 * These cases pin the exact strings the five predecessor implementations
 * produced, because the strings are persisted:
 *
 *  - `publish`  `builtin-tool-publish-artifact/src/artifact-urls.ts`
 *  - `image`    `builtin-tool-generate-image/src/artifact-urls.ts`
 *  - `video`    `builtin-tool-video-presentation/src/artifact-urls.ts`
 *  - `finalize` inline copy in `builtin-tool-video-presentation/src/pipeline/finalize.ts`
 *  - `backend`  `ContentArtifactsService#buildArtifactPreviewUrl`
 *  - `web`      `apps/web/.../_components/artifact-urls.ts`
 */

const target = { artifactId: "artifact-1", workspaceId: "workspace-1" };

test("preview page URL matches every predecessor byte for byte", () => {
  assert.equal(
    buildArtifactPreviewUrl(target),
    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
  );
  assert.equal(ARTIFACT_PREVIEW_PAGE_ROUTE, "/artifact-preview");
});

test("preview page URL form-encodes identifiers the way URLSearchParams always did", () => {
  assert.equal(
    buildArtifactPreviewUrl({ artifactId: "artifact 1", workspaceId: "workspace 1" }),
    "/artifact-preview?artifactId=artifact+1&workspaceId=workspace+1",
  );
});

test("REST family covers every artifact resource", () => {
  assert.equal(
    buildArtifactRestUrl(target),
    "/v1/workspaces/workspace-1/artifacts/artifact-1/file",
  );
  assert.equal(
    buildArtifactRestUrl({ ...target, resource: { kind: "download" } }),
    "/v1/workspaces/workspace-1/artifacts/artifact-1/download",
  );
  assert.equal(
    buildArtifactRestUrl({ ...target, resource: { kind: "previewImage" } }),
    "/v1/workspaces/workspace-1/artifacts/artifact-1/preview-image",
  );
  assert.equal(
    buildArtifactRestUrl({ ...target, resource: { kind: "sourceJson" } }),
    "/v1/workspaces/workspace-1/artifacts/artifact-1/source.json",
  );
  assert.equal(
    buildArtifactRestUrl({
      ...target,
      resource: { fileName: "narration-slide-01.mp3", kind: "asset" },
    }),
    "/v1/workspaces/workspace-1/artifacts/artifact-1/assets/narration-slide-01.mp3",
  );
});

test("REST source.json and asset shortcuts match the video predecessors", () => {
  assert.equal(
    buildArtifactSourceJsonUrl(target),
    "/v1/workspaces/workspace-1/artifacts/artifact-1/source.json",
  );
  assert.equal(
    buildArtifactAssetUrl({ ...target, fileName: "slide 1.png" }),
    "/v1/workspaces/workspace-1/artifacts/artifact-1/assets/slide%201.png",
  );
});

test("REST path segments are percent-encoded, not form-encoded", () => {
  assert.equal(
    buildArtifactRestUrl({ artifactId: "a b", workspaceId: "w b" }),
    "/v1/workspaces/w%20b/artifacts/a%20b/file",
  );
});

test("proxy family mirrors the REST resources onto the web route", () => {
  assert.equal(ARTIFACT_FILE_PROXY_ROUTE, "/api/artifact-file");
  assert.equal(
    buildArtifactProxyUrl({ ...target, resource: { kind: "file" } }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1",
  );
  assert.equal(
    buildArtifactDownloadUrl(target),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&download=1",
  );
  assert.equal(
    buildArtifactPreviewImageUrl(target),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&asset=previewImage",
  );
  assert.equal(
    buildArtifactProxyUrl({
      ...target,
      resource: { fileName: "narration-slide-01.mp3", kind: "asset" },
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&assetFileName=narration-slide-01.mp3",
  );
});

test("the proxy has no source.json verb, so it degrades to a flat asset name", () => {
  assert.equal(
    buildArtifactProxyUrl({ ...target, resource: { kind: "sourceJson" } }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&assetFileName=source.json",
  );
});

test("unsafe asset file names are rejected rather than escaped", () => {
  for (const fileName of ["", "  ", ".", "..", "../secret", "a/b", "a\\b"]) {
    assert.equal(isSafeFlatArtifactAssetFileName(fileName), false, fileName);
    assert.equal(
      buildArtifactRestUrl({ ...target, resource: { fileName, kind: "asset" } }),
      null,
      fileName,
    );
    assert.equal(
      buildArtifactProxyUrl({ ...target, resource: { fileName, kind: "asset" } }),
      null,
      fileName,
    );
  }
  assert.equal(isSafeFlatArtifactAssetFileName("source.json"), true);
});
