import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { digest, filesUnder } from "./desktop-release-artifacts.mjs";
import { releaseVersion } from "./verify-release-config.mjs";

const manifestPath = "output/downloads/manifest.json";
const immutableCache = "public, max-age=31536000, immutable";

function httpsUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS URL`);
  }
  assert(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    `${name} must be an HTTPS URL without credentials, query or fragment`,
  );
  return url.href.replace(/\/$/, "");
}

export function downloadConfig(env) {
  const required = (name) => {
    assert(env[name]?.trim(), `${name} is required for download publication`);
    return env[name].trim();
  };
  const forcePathStyle = required("DOWNLOADS_S3_FORCE_PATH_STYLE");
  assert(
    ["true", "false"].includes(forcePathStyle),
    "DOWNLOADS_S3_FORCE_PATH_STYLE must be true or false",
  );
  const prefix = (env.DOWNLOADS_S3_PREFIX ?? "").trim();
  assert(
    !prefix || prefix.split("/").every((part) => /^[A-Za-z0-9_-]+$/.test(part)),
    "DOWNLOADS_S3_PREFIX must contain safe path segments without leading/trailing slashes",
  );
  const bucket = required("DOWNLOADS_S3_BUCKET");
  assert(
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket),
    "Invalid DOWNLOADS_S3_BUCKET",
  );
  return {
    endpoint: httpsUrl(
      required("DOWNLOADS_S3_ENDPOINT"),
      "DOWNLOADS_S3_ENDPOINT",
    ),
    publicBaseUrl: httpsUrl(
      required("DOWNLOADS_PUBLIC_BASE_URL"),
      "DOWNLOADS_PUBLIC_BASE_URL",
    ),
    bucket,
    prefix,
    region: required("DOWNLOADS_S3_REGION"),
    forcePathStyle: forcePathStyle === "true",
    credentials: {
      accessKeyId: required("DOWNLOADS_S3_ACCESS_KEY_ID"),
      secretAccessKey: required("DOWNLOADS_S3_SECRET_ACCESS_KEY"),
    },
  };
}

function objectKey(config, path) {
  return config.prefix ? `${config.prefix}/${path}` : path;
}

function publicUrl(config, path) {
  // Public base maps to the bucket root; the optional prefix is added here.
  return `${config.publicBaseUrl}/${objectKey(config, path).split("/").map(encodeURIComponent).join("/")}`;
}

export async function prepareManifest(
  config,
  directory,
  tag,
  repository,
  policy = "candidate",
) {
  assert(
    ["candidate", "signed"].includes(policy),
    "Invalid desktop publication policy",
  );
  const { version, prerelease } = releaseVersion(tag);
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), "Invalid GitHub repository");
  const files = await filesUnder(directory);
  const descriptions = files.filter((path) =>
    /^desktop-manifest-.+\.json$/.test(basename(path)),
  );
  assert(descriptions.length > 0, "No desktop artifact manifests found");
  const artifacts = [];
  const uploads = [];
  const seen = new Set();
  for (const path of descriptions) {
    const entry = JSON.parse(await readFile(path, "utf8"));
    assert.equal(entry.schemaVersion, 1, "Unknown artifact manifest schema");
    assert.equal(
      entry.version,
      version,
      "Installer version does not match release tag",
    );
    assert(
      ["macos", "windows", "linux"].includes(entry.platform),
      "Invalid platform",
    );
    assert(["arm64", "x64"].includes(entry.arch), "Invalid architecture");
    assert(
      entry.platform !== "linux" || entry.arch === "x64",
      "Linux packages require x64",
    );
    const id = `${entry.platform}-${entry.arch}`;
    assert(!seen.has(id), `Duplicate platform: ${id}`);
    seen.add(id);
    assert(
      typeof entry.filename === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(entry.filename),
      "Unsafe installer filename",
    );
    assert(
      entry.filename.endsWith(
        entry.platform === "macos"
          ? ".dmg"
          : entry.platform === "linux"
            ? ".AppImage"
            : ".exe",
      ),
      "Installer extension does not match platform",
    );
    assert.equal(
      entry.distributionSigned,
      policy === "signed" && entry.platform !== "linux",
      "Installer signing does not match publication policy",
    );
    assert.equal(
      entry.notarized,
      policy === "signed" && entry.platform === "macos",
      "Installer notarization does not match publication policy",
    );
    assert.equal(
      entry.localExecutionSupported,
      entry.platform === "macos",
      "Unexpected local execution support",
    );
    const matches = files.filter((file) => basename(file) === entry.filename);
    assert.equal(
      matches.length,
      1,
      `Missing or duplicate installer: ${entry.filename}`,
    );
    const actual = await digest(createReadStream(matches[0]));
    assert(actual.size > 0, "Installer cannot be empty");
    assert.equal(actual.size, entry.size, "Installer size mismatch");
    assert.equal(actual.sha256, entry.sha256, "Installer SHA-256 mismatch");
    const relativeKey = `releases/${tag}/${entry.filename}`;
    const artifact = {
      ...entry,
      url: publicUrl(config, relativeKey),
      githubUrl: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(entry.filename)}`,
    };
    artifacts.push(artifact);
    uploads.push({
      path: matches[0],
      key: objectKey(config, relativeKey),
      artifact,
    });
  }
  assert(
    artifacts.some((a) => a.platform === "macos") &&
      artifacts.some((a) => a.platform === "windows"),
    "Both macOS and Windows installers are required",
  );
  if (policy === "signed") {
    assert.deepEqual(
      [...seen].sort(),
      ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"].sort(),
      "Signed releases require every configured desktop target",
    );
  }
  assert.equal(
    files.filter((file) => /\.(dmg|exe|AppImage)$/.test(file)).length,
    artifacts.length,
    "Unlisted installers found",
  );
  return {
    manifest: {
      schemaVersion: 1,
      version,
      tag,
      channel: prerelease ? "preview" : "stable",
      releaseNotesUrl: `https://github.com/${repository}/releases/tag/${tag}`,
      artifacts: artifacts.sort((a, b) =>
        `${a.platform}-${a.arch}`.localeCompare(`${b.platform}-${b.arch}`),
      ),
    },
    uploads,
  };
}

export async function verifyPublic(artifact, fetchImpl = fetch) {
  const response = await fetchImpl(artifact.url, {
    signal: AbortSignal.timeout(300_000),
  });
  assert.equal(
    response.status,
    200,
    `Public download returned HTTP ${response.status}`,
  );
  assert(response.body, "Public download has no body");
  const actual = await digest(response.body);
  assert.equal(actual.size, artifact.size, "Public download size mismatch");
  assert.equal(
    actual.sha256,
    artifact.sha256,
    "Public download SHA-256 mismatch",
  );
}

export function compareVersions(left, right) {
  releaseVersion(`v${left}`);
  releaseVersion(`v${right}`);
  const split = (v) => {
    const i = v.indexOf("-");
    return i < 0 ? [v, null] : [v.slice(0, i), v.slice(i + 1)];
  };
  const [a, ap] = split(left);
  const [b, bp] = split(right);
  const numeric = (x, y) =>
    BigInt(x) === BigInt(y) ? 0 : BigInt(x) > BigInt(y) ? 1 : -1;
  for (let i = 0; i < 3; i++) {
    const difference = numeric(a.split(".")[i], b.split(".")[i]);
    if (difference) return difference;
  }
  if (ap === bp) return 0;
  if (ap === null || bp === null) return ap === null ? 1 : -1;
  const aa = ap.split(".");
  const bb = bp.split(".");
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === undefined || bb[i] === undefined)
      return aa[i] === undefined ? -1 : 1;
    if (aa[i] === bb[i]) continue;
    const an = /^\d+$/.test(aa[i]);
    const bn = /^\d+$/.test(bb[i]);
    if (an && bn) return numeric(aa[i], bb[i]);
    if (an !== bn) return an ? -1 : 1;
    return aa[i] > bb[i] ? 1 : -1;
  }
  return 0;
}

export async function uploadRelease(
  config,
  prepared,
  store,
  checkPublic = verifyPublic,
) {
  for (const item of prepared.uploads) {
    await store.putImmutable(
      item.key,
      () => createReadStream(item.path),
      item.artifact,
      "application/octet-stream",
    );
    await checkPublic(item.artifact);
  }
  const body = Buffer.from(JSON.stringify(prepared.manifest, null, 2) + "\n");
  const expected = await digest([body]);
  const path = `releases/${prepared.manifest.tag}/manifest.json`;
  await store.putImmutable(
    objectKey(config, path),
    () => body,
    expected,
    "application/json",
  );
  await checkPublic({ ...expected, url: publicUrl(config, path) });
}

export async function promoteRelease(config, manifest, store) {
  const path = `channels/${manifest.channel}.json`;
  const key = objectKey(config, path);
  const previous = await store.read(key);
  if (previous) {
    const current = JSON.parse(previous.body.toString());
    assert.equal(current.schemaVersion, 1, "Unknown channel manifest schema");
    assert.equal(current.channel, manifest.channel, "Channel mismatch");
    assert(
      compareVersions(manifest.version, current.version) >= 0,
      "Refusing to downgrade the download channel",
    );
    if (current.version === manifest.version) {
      assert.deepEqual(
        current,
        manifest,
        "Cannot change an already promoted version",
      );
      return;
    }
  }
  await store.putChannel(
    key,
    Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
    previous?.etag,
  );
}

export function s3Store(config) {
  // Reuse the repository's pinned SDK rather than installing a CI-only tool.
  const require = createRequire(
    new URL("../../apps/backend/package.json", import.meta.url),
  );
  const {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
  } = require("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: config.forcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 1,
  });
  const get = async (key) => {
    try {
      return await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      );
    } catch (error) {
      if (error.name === "NoSuchKey") return null;
      throw error;
    }
  };
  return {
    async read(key) {
      const response = await get(key);
      if (!response) return null;
      assert(
        response.ETag,
        "S3 must return an ETag for conditional channel writes",
      );
      return {
        body: Buffer.from(await response.Body.transformToByteArray()),
        etag: response.ETag,
      };
    },
    async putImmutable(key, body, expected, contentType) {
      const existing = await get(key);
      if (existing) {
        assert.deepEqual(
          await digest(existing.Body),
          { size: expected.size, sha256: expected.sha256 },
          `Immutable release object differs: ${key}`,
        );
        return;
      }
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body(),
          ContentLength: expected.size,
          ContentType: contentType,
          CacheControl: immutableCache,
          Metadata: { sha256: expected.sha256 },
          IfNoneMatch: "*",
        }),
      );
    },
    async putChannel(key, body, etag) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: "application/json",
          CacheControl: "no-cache, max-age=0, must-revalidate",
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }),
        }),
      );
    },
    close() {
      client.destroy();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const mode = process.argv[2];
  assert(
    ["validate", "upload", "promote"].includes(mode),
    "Expected validate, upload or promote",
  );
  const config = downloadConfig(process.env);
  if (mode === "validate") {
    console.log(
      "Download storage configuration validated (no network access).",
    );
  } else {
    const prepared = await prepareManifest(
      config,
      "release-installers",
      process.env.GITHUB_REF_NAME,
      process.env.GITHUB_REPOSITORY,
      process.env.DESKTOP_PUBLICATION_POLICY ?? "candidate",
    );
    const store = s3Store(config);
    try {
      if (mode === "upload") {
        await uploadRelease(config, prepared, store);
        await mkdir(dirname(manifestPath), { recursive: true });
        await writeFile(
          manifestPath,
          JSON.stringify(prepared.manifest, null, 2) + "\n",
        );
      } else {
        // This local receipt exists only after every uploaded file passed verification.
        const receipt = JSON.parse(await readFile(manifestPath, "utf8"));
        assert.deepEqual(
          receipt,
          prepared.manifest,
          "Release changed since upload verification",
        );
        await promoteRelease(config, receipt, store);
      }
      console.log(
        `Download ${mode} completed: ${prepared.manifest.tag} (${prepared.manifest.channel}).`,
      );
    } finally {
      store.close();
    }
  }
}
