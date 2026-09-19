import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeInstaller, digest } from "./desktop-release-artifacts.mjs";
import {
  downloadConfig,
  prepareManifest,
  uploadRelease,
  promoteRelease,
  verifyPublic,
  compareVersions,
} from "./publish-downloads.mjs";

const env = {
  DOWNLOADS_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  DOWNLOADS_S3_BUCKET: "sourceweft-download",
  DOWNLOADS_S3_REGION: "auto",
  DOWNLOADS_S3_FORCE_PATH_STYLE: "true",
  DOWNLOADS_S3_ACCESS_KEY_ID: "test-access",
  DOWNLOADS_S3_SECRET_ACCESS_KEY: "test-secret",
  DOWNLOADS_PUBLIC_BASE_URL: "https://download.example.com",
};
const config = downloadConfig(env);

async function fixture(t, tag = "v1.2.3-rc.1") {
  const root = await mkdtemp(join(tmpdir(), "sourceweft-downloads-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [platform, arch, filename] of [
    ["darwin", "arm64", "SourceWeft_1.2.3_aarch64.dmg"],
    ["win32", "x64", "SourceWeft_1.2.3_x64-setup.exe"],
  ]) {
    const dir = join(root, platform);
    await mkdir(dir);
    await writeFile(join(dir, filename), `fixture-${platform}`);
    const entry = await describeInstaller(dir, platform, arch, tag.slice(1));
    await writeFile(
      join(dir, `desktop-manifest-${entry.platform}-${arch}.json`),
      JSON.stringify(entry),
    );
  }
  return {
    root,
    prepared: await prepareManifest(config, root, tag, "SourceWeft/SourceWeft"),
  };
}

test("configuration requires explicit credentials and validates S3/public URLs", () => {
  for (const key of Object.keys(env)) {
    const missing = { ...env };
    delete missing[key];
    assert.throws(() => downloadConfig(missing), new RegExp(key));
  }
  for (const value of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com?token=secret",
  ]) {
    assert.throws(() =>
      downloadConfig({ ...env, DOWNLOADS_PUBLIC_BASE_URL: value }),
    );
  }
  assert.throws(() =>
    downloadConfig({ ...env, DOWNLOADS_S3_FORCE_PATH_STYLE: "yes" }),
  );
  assert.throws(() =>
    downloadConfig({ ...env, DOWNLOADS_S3_PREFIX: "../escape" }),
  );
  assert.throws(() =>
    downloadConfig({
      ...env,
      DOWNLOADS_S3_ACCESS_KEY_ID: "",
      AWS_ACCESS_KEY_ID: "ambient",
    }),
  );
});

test("manifest preserves actual architectures and separates preview/stable", async (t) => {
  const { root, prepared } = await fixture(t);
  assert.equal(prepared.manifest.channel, "preview");
  assert.deepEqual(
    prepared.manifest.artifacts.map((a) => [a.platform, a.arch]),
    [
      ["macos", "arm64"],
      ["windows", "x64"],
    ],
  );
  assert.equal(prepared.manifest.artifacts[1].localExecutionSupported, false);
  assert(!JSON.stringify(prepared.manifest).includes("test-secret"));
  const prefixed = await prepareManifest(
    { ...config, prefix: "apps/desktop" },
    root,
    "v1.2.3-rc.1",
    "SourceWeft/SourceWeft",
  );
  assert(
    prefixed.manifest.artifacts[0].url.startsWith(
      "https://download.example.com/apps/desktop/releases/",
    ),
  );
  const stable = await fixture(t, "v1.2.3");
  assert.equal(stable.prepared.manifest.channel, "stable");
});

test("missing platform, tampered payload and mismatched versions fail before upload", async (t) => {
  const { root, prepared } = await fixture(t);
  await assert.rejects(
    prepareManifest(config, root, "v1.2.4", "SourceWeft/SourceWeft"),
    /version/,
  );
  await writeFile(prepared.uploads[0].path, "corrupted");
  await assert.rejects(
    prepareManifest(config, root, "v1.2.3-rc.1", "SourceWeft/SourceWeft"),
    /mismatch/,
  );
  const another = await fixture(t);
  await rm(join(another.root, "win32"), { recursive: true });
  await assert.rejects(
    prepareManifest(
      config,
      another.root,
      "v1.2.3-rc.1",
      "SourceWeft/SourceWeft",
    ),
    /Both macOS and Windows/,
  );
});

test("public verification hashes response bytes and rejects HTML errors and non-200 responses", async () => {
  const body = Buffer.from("installer");
  const expected = {
    url: "https://download.example.com/file",
    ...(await digest([body])),
  };
  await verifyPublic(expected, async () => new Response(body));
  await assert.rejects(
    verifyPublic(
      expected,
      async () => new Response("not found", { status: 404 }),
    ),
    /HTTP 404/,
  );
  await assert.rejects(
    verifyPublic(expected, async () => new Response("<html>error</html>")),
    /mismatch/,
  );
});

test("publication verifies every file before version manifest and never writes channel", async (t) => {
  const { prepared } = await fixture(t);
  const events = [];
  await uploadRelease(
    config,
    prepared,
    {
      async putImmutable(key, body, expected) {
        events.push(`put:${key}`);
        const value = body();
        assert.deepEqual(
          await digest(Buffer.isBuffer(value) ? [value] : value),
          { size: expected.size, sha256: expected.sha256 },
        );
      },
    },
    async (item) => {
      events.push(`verify:${item.url}`);
    },
  );
  assert.equal(events.length, 6);
  assert(events[4].endsWith("/manifest.json"));
  assert(events[5].endsWith("/manifest.json"));
  assert(events.every((e) => !e.includes("channels/")));
});

test("failed upload or public validation cannot publish version manifest", async (t) => {
  const { prepared } = await fixture(t);
  for (const failUpload of [true, false]) {
    const writes = [];
    await assert.rejects(
      uploadRelease(
        config,
        prepared,
        {
          async putImmutable(key) {
            writes.push(key);
            if (failUpload) throw new Error("upload failed");
          },
        },
        async () => {
          throw new Error("CDN mismatch");
        },
      ),
    );
    assert.equal(writes.length, 1);
    assert(!writes[0].endsWith("manifest.json"));
  }
});

test("channel promotion uses prior ETag, supports reruns, rejects downgrade and altered same version", async (t) => {
  const {
    prepared: { manifest },
  } = await fixture(t);
  let previous = null;
  const writes = [];
  const store = {
    async read() {
      return previous;
    },
    async putChannel(key, body, etag) {
      writes.push({ key, body, etag });
    },
  };
  await promoteRelease(config, manifest, store);
  assert.equal(writes[0].key, "channels/preview.json");
  assert.equal(writes[0].etag, undefined);
  previous = {
    body: Buffer.from(JSON.stringify({ ...manifest, version: "1.2.3-rc.0" })),
    etag: '"previous"',
  };
  await promoteRelease(config, manifest, store);
  assert.equal(writes[1].etag, '"previous"');
  previous.body = Buffer.from(JSON.stringify(manifest));
  await promoteRelease(config, manifest, store);
  assert.equal(writes.length, 2);
  await assert.rejects(
    promoteRelease(config, { ...manifest, releaseNotesUrl: "changed" }, store),
    /already promoted/,
  );
  await assert.rejects(
    promoteRelease(config, { ...manifest, version: "1.2.2" }, store),
    /downgrade/,
  );
  assert.equal(writes.length, 2);
});

test("semver ordering handles numeric prerelease parts and stable precedence", () => {
  for (const [a, b] of [
    ["1.2.3-rc.9", "1.2.3-rc.10"],
    ["1.2.3-1", "1.2.3-alpha"],
    ["1.2.3-alpha", "1.2.3-alpha.1"],
    ["1.2.3-rc.1", "1.2.3"],
    ["1.2.3", "1.10.0"],
  ]) {
    assert(compareVersions(a, b) < 0);
    assert(compareVersions(b, a) > 0);
  }
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("workflow uploads and verifies before GitHub publication and promotes last", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert(
    workflow.indexOf("publish-downloads.mjs upload") <
      workflow.indexOf("- name: Publish completed release"),
  );
  assert(
    workflow.indexOf("- name: Publish completed release") <
      workflow.indexOf("publish-downloads.mjs promote"),
  );
  assert(
    workflow.indexOf("publish-downloads.mjs validate") <
      workflow.indexOf("Build and push image"),
  );
});
