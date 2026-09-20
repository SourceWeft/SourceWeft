import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { digest } from "./desktop-release-artifacts.mjs";
import {
  compareVersions,
  downloadConfig,
  s3Store,
  verifyPublic,
} from "./publish-downloads.mjs";
import {
  channelKey,
  updateUrl,
  validateUpdateManifest,
  prepareUpdateManifest,
} from "./desktop-update-manifest.mjs";

const encode = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const content = ({ sourceweft: _control, ...release }) => release;

export async function promoteUpdate(config, manifest, channel, store) {
  validateUpdateManifest(manifest, config, channel);
  const key = channelKey(config, channel);
  const previous = await store.read(key);
  let control = { ...manifest.sourceweft };
  if (previous) {
    const current = validateUpdateManifest(
      JSON.parse(previous.body.toString()),
      config,
      channel,
    );
    const comparison = compareVersions(manifest.version, current.version);
    if (
      comparison < 0 &&
      channel === "preview" &&
      !manifest.version.includes("-")
    )
      return { channel, status: "ahead", version: current.version };
    assert(comparison >= 0, "Refusing to downgrade update channel");
    if (!comparison) {
      assert.deepEqual(
        content(manifest),
        content(current),
        "Cannot replace a published version",
      );
      return {
        channel,
        status: "unchanged",
        version: current.version,
        distribution: current.sourceweft.distribution,
      };
    }
    control = {
      schemaVersion: 1,
      revision: current.sourceweft.revision + 1,
      distribution:
        current.sourceweft.distribution === "active" ? "active" : "paused",
      reason: current.sourceweft.reason,
    };
  }
  const next = validateUpdateManifest(
    { ...manifest, sourceweft: control },
    config,
    channel,
  );
  await store.putChannel(key, encode(next), previous?.etag);
  return {
    channel,
    status: "promoted",
    version: next.version,
    distribution: control.distribution,
    revision: control.revision,
  };
}

export async function controlUpdate(
  config,
  channel,
  action,
  expectedVersion,
  reason,
  store,
) {
  assert(
    ["pause", "resume", "withdraw"].includes(action),
    "Invalid control action",
  );
  assert(
    typeof reason === "string" && reason.trim() && reason.length <= 2000,
    "A reason is required",
  );
  const key = channelKey(config, channel);
  const previous = await store.read(key);
  assert(previous, "Update channel has not been published");
  const current = validateUpdateManifest(
    JSON.parse(previous.body.toString()),
    config,
    channel,
  );
  assert.equal(
    current.version,
    expectedVersion,
    "Channel version changed; inspect before controlling it",
  );
  const state = { pause: "paused", resume: "active", withdraw: "withdrawn" }[
    action
  ];
  assert(
    current.sourceweft.distribution !== "withdrawn" || state === "withdrawn",
    "A withdrawn version requires a higher repair release",
  );
  if (current.sourceweft.distribution === state)
    return {
      channel,
      status: "unchanged",
      version: expectedVersion,
      distribution: state,
    };
  const next = {
    ...current,
    sourceweft: {
      schemaVersion: 1,
      revision: current.sourceweft.revision + 1,
      distribution: state,
      reason: reason.trim(),
    },
  };
  validateUpdateManifest(next, config, channel);
  await store.putChannel(key, encode(next), previous.etag);
  return {
    channel,
    status: action,
    version: expectedVersion,
    distribution: state,
    revision: next.sourceweft.revision,
  };
}

export async function uploadUpdates(
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
  const body = encode(prepared.manifest);
  const key = [
    config.prefix,
    `releases/v${prepared.manifest.version}/updater.json`,
  ]
    .filter(Boolean)
    .join("/");
  const expected = await digest([body]);
  await store.putImmutable(key, () => body, expected, "application/json");
  await checkPublic({ ...expected, url: updateUrl(config, key) });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const mode = process.argv[2];
  assert(
    ["validate", "upload", "promote", "pause", "resume", "withdraw"].includes(
      mode,
    ),
    "Invalid update publication mode",
  );
  const config = downloadConfig(process.env);
  assert.equal(
    config.publicBaseUrl,
    "https://download.sourceweft.com",
    "Official clients require the compiled download host",
  );
  assert.equal(
    config.prefix,
    "",
    "Official clients require the bucket-root update paths",
  );
  assert(
    process.env.TAURI_UPDATER_PUBLIC_KEY?.trim(),
    "TAURI_UPDATER_PUBLIC_KEY is required",
  );
  if (mode !== "validate") {
    const store = s3Store(config);
    const receipts = [];
    await mkdir("output/updates", { recursive: true });
    try {
      if (["pause", "resume", "withdraw"].includes(mode)) {
        const channels =
          process.env.UPDATE_CHANNEL === "both"
            ? ["stable", "preview"]
            : [process.env.UPDATE_CHANNEL];
        for (const channel of channels) {
          receipts.push(
            await controlUpdate(
              config,
              channel,
              mode,
              process.env.UPDATE_EXPECTED_VERSION,
              process.env.UPDATE_REASON,
              store,
            ),
          );
          await writeFile(
            "output/updates/control-receipt.json",
            encode(receipts),
          );
        }
      } else {
        const prepared = await prepareUpdateManifest(
          config,
          "release-installers",
          process.env.GITHUB_REF_NAME,
          await readFile(process.env.UPDATE_NOTES_FILE, "utf8"),
          process.env.UPDATE_PUB_DATE,
        );
        if (mode === "upload") {
          await uploadUpdates(config, prepared, store);
          await writeFile(
            "output/updates/verified.json",
            encode(prepared.manifest),
          );
        } else {
          assert.deepEqual(
            JSON.parse(await readFile("output/updates/verified.json", "utf8")),
            prepared.manifest,
            "Release changed since verification",
          );
          const channels = prepared.manifest.version.includes("-")
            ? ["preview"]
            : ["stable", "preview"];
          for (const channel of channels) {
            receipts.push(
              await promoteUpdate(config, prepared.manifest, channel, store),
            );
            await writeFile(
              "output/updates/promotion-receipt.json",
              encode(receipts),
            );
          }
        }
      }
      console.log(JSON.stringify(receipts));
    } finally {
      store.close();
    }
  }
}
