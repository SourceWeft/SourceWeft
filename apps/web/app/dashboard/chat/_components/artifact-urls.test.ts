import assert from "node:assert/strict";
import { test } from "vitest";
import {
  artifactApiUrlToPageUrl,
  artifactApiUrlToProxyFileUrl,
  normalizeWebAssetUrl,
  resolveArtifactProxyAssetUrl,
  resolveArtifactPageUrl,
  resolveArtifactPageUrlFromArtifact,
  resolveArtifactProxyFileUrl,
  resolveArtifactProxyFileUrlFromArtifact,
} from "./artifact-urls";

test("artifactApiUrlToPageUrl maps API file routes to the artifact page", () => {
  assert.equal(
    artifactApiUrlToPageUrl(
      "/v1/workspaces/workspace-1/artifacts/artifact-1/file",
    ),
    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("artifactApiUrlToPageUrl parses relative API file routes with query and hash", () => {
  assert.equal(
    artifactApiUrlToPageUrl(
      "/v1/workspaces/workspace-1/artifacts/artifact-1/file?token=abc#slide-2",
    ),
    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("artifactApiUrlToPageUrl maps API download routes to the artifact page", () => {
  assert.equal(
    artifactApiUrlToPageUrl(
      "/v1/workspaces/workspace-1/artifacts/artifact-1/download",
    ),
    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("resolveArtifactProxyFileUrl builds the internal file proxy URL", () => {
  assert.equal(
    resolveArtifactProxyFileUrl({
      artifactId: "artifact-1",
      workspaceId: "workspace-1",
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("artifactApiUrlToProxyFileUrl maps API file routes through the internal file proxy", () => {
  assert.equal(
    artifactApiUrlToProxyFileUrl(
      "/v1/workspaces/workspace-1/artifacts/artifact-1/file",
    ),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("resolveArtifactProxyFileUrlFromArtifact can force download mode on API file fallbacks", () => {
  assert.equal(
    resolveArtifactProxyFileUrlFromArtifact({
      download: true,
      fallbackUrl: "/v1/workspaces/workspace-1/artifacts/artifact-1/file",
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&download=1",
  );
});

test("resolveArtifactProxyFileUrlFromArtifact parses relative API download fallbacks with query and hash", () => {
  assert.equal(
    resolveArtifactProxyFileUrlFromArtifact({
      fallbackUrl:
        "/v1/workspaces/workspace-1/artifacts/artifact-1/download?token=abc#deck",
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&download=1",
  );
});

test("resolveArtifactProxyFileUrlFromArtifact maps legacy API preview fallbacks to the file proxy", () => {
  assert.equal(
    resolveArtifactProxyFileUrlFromArtifact({
      fallbackUrl:
        "/api/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("normalizeWebAssetUrl maps artifact source JSON routes through the file proxy", () => {
  assert.equal(
    normalizeWebAssetUrl("/v1/workspaces/workspace-1/artifacts/a/source.json"),
    "/api/artifact-file?artifactId=a&workspaceId=workspace-1&assetFileName=source.json",
  );
});

test("normalizeWebAssetUrl leaves non-artifact API routes on the API origin", () => {
  assert.match(
    normalizeWebAssetUrl("/v1/workspaces/workspace-1/sources/source-1/file"),
    /^http:\/\/localhost:3001\/v1\/workspaces\/workspace-1\/sources\/source-1\/file$/,
  );
});

test("normalizeWebAssetUrl maps artifact asset routes through the file proxy", () => {
  assert.equal(
    normalizeWebAssetUrl(
      "/v1/workspaces/workspace-1/artifacts/artifact-1/assets/narration-slide-01.mp3",
    ),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&assetFileName=narration-slide-01.mp3",
  );
});

test("artifact asset URLs are flat-only", () => {
  assert.equal(
    resolveArtifactProxyAssetUrl({
      artifactId: "artifact-1",
      fileName: "nested/file.mp3",
      workspaceId: "workspace-1",
    }),
    null,
  );
  assert.equal(
    normalizeWebAssetUrl(
      "/v1/workspaces/workspace-1/artifacts/artifact-1/assets/nested%2Ffile.mp3",
    ),
    "http://localhost:3001/v1/workspaces/workspace-1/artifacts/artifact-1/assets/nested%2Ffile.mp3",
  );
  assert.equal(
    normalizeWebAssetUrl(
      "/api/artifact-file?workspaceId=workspace-1&artifactId=artifact-1&assetFileName=../secret",
    ),
    "/api/artifact-file?workspaceId=workspace-1&artifactId=artifact-1&assetFileName=../secret",
  );
});

test("resolveArtifactPageUrl builds artifact page URLs", () => {
  assert.equal(
    resolveArtifactPageUrl({
      artifactId: "artifact-1",
      workspaceId: "workspace-1",
    }),
    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("resolveArtifactPageUrlFromArtifact uses workspace and artifact identifiers before fallback URLs", () => {
  assert.equal(
    resolveArtifactPageUrlFromArtifact({
      artifactId: "artifact-1",
      fallbackUrl: "https://example.com/file.png",
      workspaceId: "workspace-1",
    }),
    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("resolveArtifactPageUrlFromArtifact keeps API file fallbacks as artifact pages", () => {
  assert.equal(
    resolveArtifactPageUrlFromArtifact({
      fallbackUrl: "/v1/workspaces/workspace-1/artifacts/artifact-1/file",
    }),
    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("resolveArtifactPageUrlFromArtifact maps legacy API preview fallbacks to the artifact page", () => {
  assert.equal(
    resolveArtifactPageUrlFromArtifact({
      fallbackUrl:
        "/api/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
    }),
    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
  );
});
