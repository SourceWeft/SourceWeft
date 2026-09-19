import test from "node:test";
import assert from "node:assert/strict";
import {
  promoteUpdate,
  controlUpdate,
  uploadUpdates,
} from "./publish-desktop-updates.mjs";
import {
  UPDATE_TARGETS,
  updateExtension,
  validateUpdateManifest,
} from "./desktop-update-manifest.mjs";

const config = { prefix: "", publicBaseUrl: "https://download.sourceweft.com" };
function manifest(version = "0.2.0-rc.3") {
  return {
    version,
    notes: "Fixes",
    pub_date: "2026-09-20T00:00:00Z",
    platforms: Object.fromEntries(
      Object.values(UPDATE_TARGETS).map((target) => [
        target,
        {
          url: `${config.publicBaseUrl}/releases/v${version}/${target}${updateExtension(target)}`,
          signature: "dGVzdA==",
        },
      ]),
    ),
    sourceweft: {
      schemaVersion: 1,
      distribution: "active",
      revision: 1,
      reason: "",
    },
  };
}
function storage() {
  const objects = new Map();
  let writes = 0;
  return {
    objects,
    get writes() {
      return writes;
    },
    async read(key) {
      const value = objects.get(key);
      return value ? { ...value } : null;
    },
    async putChannel(key, body, etag) {
      assert.equal(objects.get(key)?.etag, etag, "ETag conflict");
      objects.set(key, { body, etag: String(++writes) });
    },
    async putImmutable() {},
  };
}
const read = (store, channel) =>
  JSON.parse(store.objects.get(`updates/${channel}.json`).body);

test("RC to stable to next RC and numeric prerelease ordering", async () => {
  const store = storage();
  for (const version of ["0.2.0-rc.3", "0.2.0-rc.10", "0.2.0", "0.2.1-rc.1"]) {
    await promoteUpdate(config, manifest(version), "preview", store);
    assert.equal(read(store, "preview").version, version);
  }
  await assert.rejects(
    promoteUpdate(config, manifest("0.2.0-rc.99"), "preview", store),
    /downgrade/,
  );
  const result = await promoteUpdate(
    config,
    manifest("0.2.0"),
    "preview",
    store,
  );
  assert.equal(result.status, "ahead");
});

test("stable rejects RC and formal release initializes preview", async () => {
  const store = storage();
  await assert.rejects(
    promoteUpdate(config, manifest(), "stable", store),
    /prerelease/,
  );
  await promoteUpdate(config, manifest("0.2.0"), "stable", store);
  await promoteUpdate(config, manifest("0.2.0"), "preview", store);
  assert.equal(read(store, "preview").version, "0.2.0");
});

test("pause persists across release, and only explicit resume enables distribution", async () => {
  const store = storage();
  await promoteUpdate(config, manifest(), "preview", store);
  await controlUpdate(
    config,
    "preview",
    "pause",
    "0.2.0-rc.3",
    "Investigating",
    store,
  );
  await promoteUpdate(config, manifest("0.2.0"), "preview", store);
  assert.equal(read(store, "preview").sourceweft.distribution, "paused");
  await controlUpdate(config, "preview", "resume", "0.2.0", "Verified", store);
  assert.equal(read(store, "preview").sourceweft.distribution, "active");
  assert.equal(read(store, "preview").sourceweft.revision, 4);
});

test("withdrawn version cannot resume or evade withdrawal via same-version publication", async () => {
  const store = storage();
  await promoteUpdate(config, manifest(), "preview", store);
  await controlUpdate(
    config,
    "preview",
    "withdraw",
    "0.2.0-rc.3",
    "Bad build",
    store,
  );
  for (const action of ["resume", "pause"])
    await assert.rejects(
      controlUpdate(config, "preview", action, "0.2.0-rc.3", "No", store),
      /repair/,
    );
  await promoteUpdate(config, manifest(), "preview", store);
  assert.equal(read(store, "preview").sourceweft.distribution, "withdrawn");
  await promoteUpdate(config, manifest("0.2.0-rc.4"), "preview", store);
  assert.equal(read(store, "preview").sourceweft.distribution, "paused");
});

test("control is version-bound, channel-specific and idempotent", async () => {
  const store = storage();
  for (const channel of ["preview", "stable"])
    await promoteUpdate(config, manifest("0.2.0"), channel, store);
  await assert.rejects(
    controlUpdate(config, "preview", "pause", "0.1.0", "Stale", store),
    /changed/,
  );
  await controlUpdate(
    config,
    "preview",
    "pause",
    "0.2.0",
    "Investigate",
    store,
  );
  const count = store.writes;
  await controlUpdate(config, "preview", "pause", "0.2.0", "Retry", store);
  assert.equal(store.writes, count);
  assert.equal(read(store, "stable").sourceweft.distribution, "active");
  await assert.rejects(
    controlUpdate(config, "other", "pause", "0.2.0", "Wrong", store),
  );
});

test("same version content cannot change even during pause", async () => {
  const store = storage();
  await promoteUpdate(config, manifest(), "preview", store);
  await controlUpdate(
    config,
    "preview",
    "pause",
    "0.2.0-rc.3",
    "Investigate",
    store,
  );
  await assert.rejects(
    promoteUpdate(
      config,
      { ...manifest(), notes: "Replacement" },
      "preview",
      store,
    ),
    /replace/,
  );
});

test("stale concurrent promotion cannot undo a pause", async () => {
  const store = storage();
  await promoteUpdate(config, manifest(), "preview", store);
  const normalRead = store.read;
  let raced = false;
  store.read = async (key) => {
    const old = await normalRead(key);
    if (!raced) {
      raced = true;
      await controlUpdate(
        config,
        "preview",
        "pause",
        "0.2.0-rc.3",
        "Concurrent pause",
        store,
      );
    }
    return old;
  };
  await assert.rejects(
    promoteUpdate(config, manifest("0.2.0-rc.4"), "preview", store),
    /ETag conflict/,
  );
  assert.equal(read(store, "preview").sourceweft.distribution, "paused");
});

test("malformed control, wrong host, missing targets fail closed", () => {
  for (const change of [
    (m) => {
      delete m.sourceweft;
    },
    (m) => {
      m.sourceweft.distribution = "unknown";
    },
    (m) => {
      m.sourceweft.revision = 0;
    },
    (m) => {
      delete m.platforms["darwin-x86_64"];
    },
    (m) => {
      m.platforms["windows-x86_64"].url = "https://evil.example/pkg.exe";
    },
    (m) => {
      m.platforms["windows-x86_64"].url += "?redirect=1";
    },
  ]) {
    const m = manifest();
    change(m);
    assert.throws(() => validateUpdateManifest(m, config));
  }
});

test("Linux cannot be published with a Windows package or silently omitted", () => {
  const m = manifest();
  m.platforms["linux-x86_64"].url = m.platforms["linux-x86_64"].url.replace(
    ".AppImage",
    ".exe",
  );
  assert.throws(() => validateUpdateManifest(m, config), /package type/);
  delete m.platforms["linux-x86_64"];
  assert.throws(() => validateUpdateManifest(m, config), /targets/);
});

test("public verification failure cannot publish updater manifest or promote any channel", async () => {
  let immutableWrites = 0;
  const store = storage();
  store.putImmutable = async () => {
    immutableWrites++;
  };
  await assert.rejects(
    uploadUpdates(
      config,
      {
        manifest: manifest(),
        uploads: [{ path: "unused", key: "file", artifact: {} }],
      },
      store,
      async () => {
        throw new Error("Public hash mismatch");
      },
    ),
    /hash mismatch/,
  );
  assert.equal(immutableWrites, 1);
  assert.equal(store.writes, 0);
});
