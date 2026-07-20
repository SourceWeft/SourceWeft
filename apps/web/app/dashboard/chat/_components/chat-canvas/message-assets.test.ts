import assert from "node:assert/strict";
import { test } from "vitest";
import {
  resolveArtifactDownloadUrl,
  resolveArtifactFileUrl,
  resolveArtifactUrl,
} from "./message-assets";

test("resolveArtifactUrl maps generated artifact files through the web preview proxy", () => {
  assert.equal(
    resolveArtifactUrl({
      artifact: {
        artifactId: "artifact-1",
        artifactUrl: "/v1/workspaces/workspace-1/artifacts/artifact-1/file",
        title: "Artifact",
      },
      workspaceId: "workspace-1",
    }),
    "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("resolveArtifactFileUrl maps generated image artifacts through the file proxy", () => {
  assert.equal(
    resolveArtifactFileUrl({
      artifact: {
        artifactId: "artifact-1",
        artifactUrl:
          "/artifact-preview?artifactId=artifact-1&workspaceId=workspace-1",
      },
      workspaceId: "workspace-1",
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1",
  );
});

test("resolveArtifactDownloadUrl maps generated artifact downloads through the file proxy", () => {
  assert.equal(
    resolveArtifactDownloadUrl({
      artifact: { artifactId: "artifact-1" },
      workspaceId: "workspace-1",
    }),
    "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&download=1",
  );
});
