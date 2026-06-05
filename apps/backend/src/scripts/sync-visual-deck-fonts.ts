import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  buildVisualDeckFontRegistryStorageKey,
  buildVisualDeckFontStorageKey,
  buildVisualDeckLicenseStorageKey,
  buildVisualDeckPublicUrlForStorageKey,
  normalizeVisualDeckFontPrefix,
  visualDeckFontRegistry,
} from "../modules/content/agent/tools/visual-deck-fonts";
import { config } from "../shared/config";

type CliOptions = {
  dryRun: boolean;
  prefix: string;
  sourceRef: string;
};

const immutableCacheControl = "public,max-age=31536000,immutable";
const registryCacheControl = "public,max-age=300";

function usage() {
  return [
    "Usage: pnpm --filter @sourceweft/backend fonts:sync [options]",
    "",
    "Options:",
    "  --prefix <path>          Public S3 key prefix. Defaults to FONT_ASSET_PREFIX or fonts.",
    "  --source-ref <ref>       google/fonts git ref. Use a commit SHA in production. Defaults to GOOGLE_FONTS_REF or main.",
    "  --dry-run                Download and hash fonts, but do not upload.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    prefix: process.env.FONT_ASSET_PREFIX || "fonts",
    sourceRef: process.env.GOOGLE_FONTS_REF || "main",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--prefix") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--prefix requires a value");
      }
      options.prefix = value;
      index += 1;
      continue;
    }
    if (arg === "--source-ref") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--source-ref requires a value");
      }
      options.sourceRef = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.info(usage());
      process.exit(0);
    }

    throw new Error(`Unknown fonts sync option: ${arg}\n\n${usage()}`);
  }

  options.prefix = normalizeVisualDeckFontPrefix(options.prefix);
  return options;
}

function validatePublicS3Config() {
  const missing = [
    ["PUBLIC_S3_BUCKET", config.publicS3.bucket],
    ["PUBLIC_S3_REGION", config.publicS3.region],
    ["PUBLIC_S3_ENDPOINT", config.publicS3.endpoint],
    ["PUBLIC_S3_ACCESS_KEY_ID", config.publicS3.accessKeyId],
    ["PUBLIC_S3_SECRET_ACCESS_KEY", config.publicS3.secretAccessKey],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(
      `Missing public S3 configuration: ${missing.map(([name]) => name).join(", ")}`,
    );
  }

  if (config.publicS3.baseUrl) {
    const baseUrl = new URL(config.publicS3.baseUrl);
    if (baseUrl.protocol !== "https:") {
      throw new Error("PUBLIC_S3_BASE_URL must be an HTTPS URL");
    }
  }
}

function publicS3Client() {
  return new S3Client({
    region: config.publicS3.region,
    credentials: {
      accessKeyId: config.publicS3.accessKeyId,
      secretAccessKey: config.publicS3.secretAccessKey,
    },
    endpoint: config.publicS3.endpoint,
    forcePathStyle: config.publicS3.forcePathStyle,
  });
}

async function downloadBuffer(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed ${response.status}: ${url}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function googleFontsRawUrl(sourceRef: string, path: string) {
  return `https://raw.githubusercontent.com/google/fonts/${sourceRef}/${path}`;
}

async function uploadObject(input: {
  client: S3Client;
  key: string;
  body: Buffer;
  contentType: string;
  cacheControl: string;
  dryRun: boolean;
}) {
  if (input.dryRun) {
    console.info(`[dry-run] upload ${input.key}`);
    return;
  }

  await input.client.send(
    new PutObjectCommand({
      Bucket: config.publicS3.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      CacheControl: input.cacheControl,
    }),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  validatePublicS3Config();

  const client = publicS3Client();
  const registry = [];

  for (const font of Object.values(visualDeckFontRegistry)) {
    const sourceUrl = googleFontsRawUrl(options.sourceRef, font.fontPath);
    const licenseUrl = googleFontsRawUrl(options.sourceRef, font.licensePath);
    console.info(`Downloading ${font.key}...`);
    const [fontBuffer, licenseBuffer] = await Promise.all([
      downloadBuffer(sourceUrl),
      downloadBuffer(licenseUrl),
    ]);
    const fontSha256 = sha256(fontBuffer);
    if (fontSha256 !== font.sha256) {
      throw new Error(
        `${font.key} sha256 mismatch: expected ${font.sha256}, got ${fontSha256}. Update the shared font registry before publishing changed font assets.`,
      );
    }

    const fontKey = buildVisualDeckFontStorageKey(font, options.prefix);
    const licenseKey = buildVisualDeckLicenseStorageKey(font, options.prefix);
    const publicFontUrl = buildVisualDeckPublicUrlForStorageKey(fontKey);
    const publicLicenseUrl = buildVisualDeckPublicUrlForStorageKey(licenseKey);

    await uploadObject({
      client,
      key: fontKey,
      body: fontBuffer,
      contentType: "font/ttf",
      cacheControl: immutableCacheControl,
      dryRun: options.dryRun,
    });
    await uploadObject({
      client,
      key: licenseKey,
      body: licenseBuffer,
      contentType: "text/plain; charset=utf-8",
      cacheControl: immutableCacheControl,
      dryRun: options.dryRun,
    });

    registry.push({
      key: font.key,
      family: font.family,
      cssFamily: font.cssFamily,
      weights: font.weights,
      roles: font.roles,
      fallback: font.fallback,
      webUrl: publicFontUrl,
      embedUrl: publicFontUrl,
      format: "truetype",
      license: "OFL-1.1",
      licenseUrl: publicLicenseUrl,
      sha256: fontSha256,
      bytes: fontBuffer.byteLength,
      sourceUrl,
      sourceRef: options.sourceRef,
    });

    console.info(
      `Prepared ${font.key}: ${fontKey} (${fontBuffer.byteLength} bytes, sha256=${fontSha256})`,
    );
  }

  const registryBody = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`);
  const registryKey = buildVisualDeckFontRegistryStorageKey(options.prefix);
  await uploadObject({
    client,
    key: registryKey,
    body: registryBody,
    contentType: "application/json; charset=utf-8",
    cacheControl: registryCacheControl,
    dryRun: options.dryRun,
  });

  console.info("");
  console.info(
    `Registry URL: ${buildVisualDeckPublicUrlForStorageKey(registryKey)}`,
  );
  console.info(JSON.stringify(registry, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
