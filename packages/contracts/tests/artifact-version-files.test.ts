import assert from "node:assert/strict";
import { test } from "node:test";
import {
  artifactVersionFilesSchema,
  parseArtifactVersionFiles,
} from "../src/artifact-version-files";
import { artifactExecutionCsp } from "../src/artifact-execution";

const file = {
  fileName: "page.html",
  contentType: "text/html",
  byteLength: 10,
  contentDigest: `sha256:${"a".repeat(64)}`,
  storageBucket: "content",
  storageKey: "object-1",
  role: "primary",
  access: "artifact",
};

test("version files preserve each format's immutable identity", () => {
  for (const [fileName, contentType] of [
    ["page.html", "text/html"],
    ["data.csv", "text/csv"],
  ]) {
    const parsed = artifactVersionFilesSchema.parse({
      schemaVersion: 1,
      files: [{ ...file, fileName, contentType }],
    });
    assert.equal(parsed.files[0]?.storageKey, "object-1");
    assert.equal(parsed.files[0]?.fileName, fileName);
  }
  assert.equal(parseArtifactVersionFiles(null), null);
  assert.throws(() => parseArtifactVersionFiles({}));
});

test("version manifests reject ambiguous names, extra primary files and public authoring", () => {
  for (const files of [
    [file, { ...file, role: "asset" }],
    [file, { ...file, fileName: "other.html" }],
    [{ ...file, role: "source" }],
    [{ ...file, fileName: "../page.html" }],
    [{ ...file, fileName: "page\n.html" }],
  ])
    assert.equal(
      artifactVersionFilesSchema.safeParse({ schemaVersion: 1, files }).success,
      false,
    );
});

test("registered HTML policy permits local interaction while denying host and external access", () => {
  const csp = artifactExecutionCsp("sandboxed-html", [
    "https://app.example/test",
  ]);
  assert.match(csp, /sandbox allow-scripts/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-ancestors 'self' https:\/\/app.example/);
  assert.doesNotMatch(
    csp,
    /allow-same-origin|unsafe-eval|allow-top-navigation/,
  );
});
