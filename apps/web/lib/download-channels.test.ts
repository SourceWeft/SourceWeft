import assert from "node:assert/strict";
import { test } from "vitest";

import {
  channelManifestUrl,
  fetchDownloadChannels,
  findArtifact,
  formatArtifactSize,
  parseChannelManifest,
} from "./download-channels";

const sha = "a".repeat(64);

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    version: "0.2.0-rc.2",
    platform: "macos",
    arch: "arm64",
    filename: "SourceWeft_0.2.0-rc.2_aarch64.dmg",
    size: 6891744,
    sha256: sha,
    url: "https://download.sourceweft.com/releases/v0.2.0-rc.2/SourceWeft_0.2.0-rc.2_aarch64.dmg",
    githubUrl:
      "https://github.com/SourceWeft/SourceWeft/releases/download/v0.2.0-rc.2/SourceWeft_0.2.0-rc.2_aarch64.dmg",
    distributionSigned: false,
    notarized: false,
    localExecutionSupported: true,
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    version: "0.2.0-rc.2",
    tag: "v0.2.0-rc.2",
    channel: "preview",
    releaseNotesUrl:
      "https://github.com/SourceWeft/SourceWeft/releases/tag/v0.2.0-rc.2",
    artifacts: [
      artifact(),
      artifact({
        platform: "windows",
        arch: "x64",
        filename: "SourceWeft_0.2.0-rc.2_x64-setup.exe",
        localExecutionSupported: false,
      }),
    ],
    ...overrides,
  };
}

test("parses a published channel manifest", () => {
  const parsed = parseChannelManifest(manifest(), "preview");
  assert.ok(parsed);
  assert.equal(parsed.version, "0.2.0-rc.2");
  assert.equal(parsed.artifacts.length, 2);
  assert.equal(findArtifact(parsed, "macos", "arm64")?.arch, "arm64");
  assert.equal(findArtifact(parsed, "windows")?.arch, "x64");
  assert.equal(findArtifact(parsed, "linux"), null);
});

test("rejects manifests that violate the published schema", () => {
  assert.equal(parseChannelManifest(null), null);
  assert.equal(parseChannelManifest(manifest({ schemaVersion: 2 })), null);
  assert.equal(parseChannelManifest(manifest({ artifacts: [] })), null);
  assert.equal(
    parseChannelManifest(manifest({ channel: "stable" }), "preview"),
    null,
    "a preview document must never be presented as stable",
  );
  assert.equal(
    parseChannelManifest(manifest({ artifacts: [artifact(), artifact()] })),
    null,
    "duplicate platform/arch pairs are invalid",
  );
  assert.equal(
    parseChannelManifest(manifest({ tag: "v0.2.0 <script>" })),
    null,
  );
});

test("rejects unsafe artifact links and checksums", () => {
  for (const bad of [
    { url: "javascript:alert(1)" },
    { url: "http://download.sourceweft.com/x.dmg" },
    { githubUrl: "https://user:pw@github.com/x.dmg" },
    { sha256: "not-a-digest" },
    { size: 0 },
    { filename: "../escape.dmg" },
    { arch: "riscv" },
  ]) {
    assert.equal(
      parseChannelManifest(manifest({ artifacts: [artifact(bad)] })),
      null,
      JSON.stringify(bad),
    );
  }
});

test("skips artifacts for platforms the page does not know", () => {
  const parsed = parseChannelManifest(
    manifest({ artifacts: [artifact(), artifact({ platform: "freebsd" })] }),
  );
  assert.ok(parsed);
  assert.deepEqual(
    parsed.artifacts.map((entry) => entry.platform),
    ["macos"],
  );
});

test("fetchDownloadChannels degrades to null channels without throwing", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/channels/stable.json")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(manifest()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const channels = await fetchDownloadChannels(
    fetchImpl,
    "https://download.example.com",
  );
  assert.deepEqual(calls.sort(), [
    channelManifestUrl("preview", "https://download.example.com"),
    channelManifestUrl("stable", "https://download.example.com"),
  ]);
  assert.equal(channels.stable, null);
  assert.equal(channels.preview?.tag, "v0.2.0-rc.2");

  const failing = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  assert.deepEqual(await fetchDownloadChannels(failing), {
    stable: null,
    preview: null,
  });

  const malformed = (async () =>
    new Response("{ not json", { status: 200 })) as typeof fetch;
  assert.deepEqual(await fetchDownloadChannels(malformed), {
    stable: null,
    preview: null,
  });
});

test("formats installer sizes for display", () => {
  assert.equal(formatArtifactSize(6891744), "6.6 MB");
  assert.equal(formatArtifactSize(150 * 1024 * 1024), "150 MB");
});
