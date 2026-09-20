import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";

// A rerun reuses completed signed bytes: signing/notarization timestamps must
// never cause the same immutable version to be rebuilt and overwritten.
const {
  GITHUB_REPOSITORY: repo,
  GITHUB_RUN_ID: run,
  GITHUB_SHA: sha,
  DESKTOP_RELEASE_TARGET: target,
  GH_TOKEN: token,
} = process.env;
assert(
  repo && run && sha && target && token,
  "Missing artifact lookup context",
);
const expected = `desktop-release-${target}-${sha}`;
const matches = [];
for (let page = 1; ; page++) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/runs/${run}/artifacts?per_page=100&page=${page}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert(response.ok, `Artifact lookup failed: HTTP ${response.status}`);
  const data = await response.json();
  for (const artifact of data.artifacts)
    if (artifact.name === expected) {
      assert(
        !artifact.expired,
        "Signed artifact expired; use a new release version",
      );
      matches.push(artifact);
    }
  if (data.artifacts.length < 100) break;
}
assert(matches.length <= 1, "Duplicate signed artifacts");
await appendFile(process.env.GITHUB_OUTPUT, `exists=${matches.length === 1}\n`);
