import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import {
  projectArtifactVersionFiles,
  readArtifactVersionFile,
  resolveArtifactVersionFile,
} from "./version-files";

const body = Buffer.from("<html>version one</html>");
const primary = {
  fileName: "index.html",
  contentType: "text/html",
  byteLength: body.byteLength,
  contentDigest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
  role: "primary" as const,
  access: "artifact" as const,
  storageBucket: "files",
  storageKey: "workspaces/w/artifacts/a/one/index.html",
};
const filesJson = {
  schemaVersion: 1,
  files: [
    primary,
    {
      ...primary,
      fileName: "authoring.zip",
      role: "source",
      access: "private",
      storageKey: "workspaces/w/artifacts/a/one/source.zip",
    },
  ],
};

test("file resolution never substitutes another version or exposes private authoring", () => {
  const input = {
    workspaceId: "w",
    artifactId: "a",
    filesJson,
    resource: { kind: "file" as const },
  };
  assert.equal(
    resolveArtifactVersionFile(input).storageKey,
    primary.storageKey,
  );
  assert.throws(
    () => resolveArtifactVersionFile({ ...input, filesJson: null }),
    /ARTIFACT_VERSION_FILE_NOT_FOUND|no authorized file/,
  );
  assert.throws(() =>
    resolveArtifactVersionFile({
      ...input,
      resource: { kind: "asset", fileName: "authoring.zip" },
    }),
  );
  assert.throws(() =>
    resolveArtifactVersionFile({ ...input, workspaceId: "other" }),
  );
});

test("file projections retain digest and identity while removing storage and private files", () => {
  const projection = projectArtifactVersionFiles({
    filesJson,
    url: (resource) => `/authorized/version-one/${resource.kind}`,
  });
  assert.equal(projection?.length, 1);
  assert.equal(projection?.[0]?.contentDigest, primary.contentDigest);
  assert.equal(
    projection?.[0]?.downloadUrl,
    "/authorized/version-one/download",
  );
  assert.doesNotMatch(
    JSON.stringify(projection),
    /storageKey|storageBucket|authoring/,
  );
});

test("version reads verify the persisted bytes instead of trusting storage", async () => {
  assert.deepEqual(
    (await readArtifactVersionFile(primary, async () => body)).body,
    body,
  );
  await assert.rejects(
    readArtifactVersionFile(primary, async () =>
      Buffer.from("<html>version two</html>"),
    ),
    /does not match/,
  );
});
