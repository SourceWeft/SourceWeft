import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureRuntimeAssets,
  type RuntimeAssetPlan,
  type RuntimeAssetSessionLike,
} from "../../src/runtime/runtime-assets";

const SHA = "a".repeat(64);

function plan(overrides: Partial<RuntimeAssetPlan> = {}): RuntimeAssetPlan {
  return {
    name: "chrome-headless-shell",
    version: "149.0.7790.0",
    platform: "linux-x64",
    sha256: SHA,
    archive: "zip",
    entrypoint: "chrome-headless-shell-linux64/chrome-headless-shell",
    ...overrides,
  };
}

/**
 * Fake session: an in-memory file map plus scripted execute outcomes. The
 * engine's shell commands are opaque strings; the fake asserts on their
 * structure (curl / sha256sum / mv) rather than interpreting them.
 */
function fakeSession(input: {
  files?: Map<string, Uint8Array>;
  executeResults?: Array<{ exitCode: number; output?: string }>;
}) {
  const files = input.files ?? new Map<string, Uint8Array>();
  const executed: string[] = [];
  const results = [...(input.executeResults ?? [])];
  const session: RuntimeAssetSessionLike = {
    rootDir: "/workspace",
    execute: async (command) => {
      executed.push(command);
      const next = results.shift() ?? { exitCode: 0, output: "" };
      return { exitCode: next.exitCode, output: next.output ?? "" };
    },
    uploadFiles: async (uploads) => {
      for (const [path, content] of uploads) {
        files.set(path, content);
      }
      return uploads.map(([path]) => ({ path }));
    },
    downloadFiles: async (paths) =>
      paths.map((path) => {
        const content = files.get(path);
        return content
          ? { path, content }
          : { path, content: null, error: "not found" };
      }),
  };
  return { session, executed, files };
}

const STAMP_PATH =
  "/workspace/.sourceweft-assets/chrome-headless-shell/149.0.7790.0/.sourceweft-asset.json";

test("image rung: a baked asset declared via env wins with one probe command", async () => {
  const { session, executed } = fakeSession({
    executeResults: [
      {
        exitCode: 0,
        output: "/opt/chrome-headless-shell/chrome-headless-shell",
      },
    ],
  });

  const [resolution] = await ensureRuntimeAssets({
    session,
    assets: [
      plan({
        imagePathEnvVar: "SOURCEWEFT_REMOTION_BROWSER",
        fetchUrl: async () => "https://cache.example/x.zip",
      }),
    ],
  });

  assert.equal(resolution?.ok, true);
  assert.equal(resolution?.rung, "image");
  assert.equal(
    resolution?.entrypointPath,
    "/opt/chrome-headless-shell/chrome-headless-shell",
  );
  assert.equal(executed.length, 1);
  assert.match(executed[0]!, /test -x "\$SOURCEWEFT_REMOTION_BROWSER"/u);
});

test("image rung misses cleanly when the env is unset or not executable", async () => {
  const { session } = fakeSession({
    // probe fails, then fetch succeeds.
    executeResults: [{ exitCode: 1, output: "" }, { exitCode: 0 }],
  });

  const [resolution] = await ensureRuntimeAssets({
    session,
    assets: [
      plan({
        imagePathEnvVar: "SOURCEWEFT_REMOTION_BROWSER",
        fetchUrl: async () => "https://cache.example/x.zip",
      }),
    ],
  });

  assert.equal(resolution?.ok, true);
  assert.equal(resolution?.rung, "fetch");
});

test("an unsafe image env var name is rejected before touching the session", async () => {
  const { session, executed } = fakeSession({});
  const [resolution] = await ensureRuntimeAssets({
    session,
    assets: [plan({ imagePathEnvVar: 'X"; rm -rf /; "' })],
  });
  assert.equal(resolution?.ok, false);
  assert.match(resolution?.error ?? "", /unsafe image env var/u);
  assert.equal(executed.length, 0);
});

test("valid stamp resolves immediately without executing anything", async () => {
  const files = new Map<string, Uint8Array>([
    [
      STAMP_PATH,
      new TextEncoder().encode(
        JSON.stringify({ version: "149.0.7790.0", sha256: SHA }),
      ),
    ],
  ]);
  const { session, executed } = fakeSession({ files });

  const [resolution] = await ensureRuntimeAssets({
    session,
    assets: [plan({ fetchUrl: async () => "https://cache.example/x.zip" })],
  });

  assert.equal(resolution?.ok, true);
  assert.equal(resolution?.rung, "stamp");
  assert.equal(
    resolution?.entrypointPath,
    "/workspace/.sourceweft-assets/chrome-headless-shell/149.0.7790.0/chrome-headless-shell-linux64/chrome-headless-shell",
  );
  assert.equal(executed.length, 0);
});

test("stale stamp (different version content) is not trusted", async () => {
  const files = new Map<string, Uint8Array>([
    [
      STAMP_PATH,
      new TextEncoder().encode(
        JSON.stringify({ version: "149.0.7790.0", sha256: "b".repeat(64) }),
      ),
    ],
  ]);
  const { session } = fakeSession({ files });

  const [resolution] = await ensureRuntimeAssets({
    session,
    assets: [plan()],
  });

  // No rungs configured → failure, but the point is the stamp did not pass.
  assert.equal(resolution?.ok, false);
});

test("fetch rung stages, stamps last, and reports", async () => {
  const { session, executed, files } = fakeSession({
    executeResults: [{ exitCode: 0 }],
  });

  const [resolution] = await ensureRuntimeAssets({
    session,
    assets: [
      plan({ fetchUrl: async () => "https://cache.example/asset.zip?sig=abc" }),
    ],
  });

  assert.equal(resolution?.ok, true);
  assert.equal(resolution?.rung, "fetch");
  assert.equal(executed.length, 1);
  const command = executed[0]!;
  assert.match(command, /curl -fsSL --retry 4/u);
  assert.match(command, /sha256sum -c/u);
  assert.match(command, /unzip -q asset\.zip/u);
  assert.match(command, /chmod \+x/u);
  // Stamp written after the promote command succeeded.
  const stamp = files.get(STAMP_PATH);
  assert.ok(stamp);
  const parsed = JSON.parse(new TextDecoder().decode(stamp)) as {
    rung: string;
    sha256: string;
  };
  assert.equal(parsed.rung, "fetch");
  assert.equal(parsed.sha256, SHA);
});

test("failed fetch degrades to the upload rung", async () => {
  const { session, executed } = fakeSession({
    // fetch command fails, upload-prepare + unpack succeed.
    executeResults: [
      { exitCode: 1, output: "curl: (56) read ECONNRESET" },
      { exitCode: 0 },
      { exitCode: 0 },
    ],
  });

  const [resolution] = await ensureRuntimeAssets({
    session,
    assets: [
      plan({
        fetchUrl: async () => "https://cache.example/asset.zip",
        loadContent: async () => new Uint8Array([1, 2, 3]),
      }),
    ],
  });

  assert.equal(resolution?.ok, true);
  assert.equal(resolution?.rung, "upload");
  assert.equal(resolution?.bytes, 3);
  assert.equal(executed.length, 3);
});

test("all rungs exhausted reports every error and never throws", async () => {
  const { session } = fakeSession({
    executeResults: [
      { exitCode: 1, output: "curl failed" },
      { exitCode: 0 },
      { exitCode: 1, output: "unzip: corrupt" },
    ],
  });

  const [resolution] = await ensureRuntimeAssets({
    session,
    assets: [
      plan({
        fetchUrl: async () => "https://cache.example/asset.zip",
        loadContent: async () => new Uint8Array([9]),
      }),
    ],
  });

  assert.equal(resolution?.ok, false);
  assert.match(resolution?.error ?? "", /fetch: exit 1/u);
  assert.match(resolution?.error ?? "", /upload: exit 1/u);
});

test("unsafe plans are rejected before touching the session", async () => {
  const { session, executed } = fakeSession({});
  const resolutions = await ensureRuntimeAssets({
    session,
    assets: [
      plan({ name: "../evil" }),
      plan({ version: "1; rm -rf /" }),
      plan({ sha256: "nope" }),
      plan({ entrypoint: "../../escape" }),
    ],
  });
  assert.ok(resolutions.every((resolution) => !resolution.ok));
  assert.equal(executed.length, 0);
});

test("installDir overrides the version-nested default placement", async () => {
  const { session, executed, files } = fakeSession({
    executeResults: [{ exitCode: 0 }],
  });

  const [resolution] = await ensureRuntimeAssets({
    session,
    assets: [
      plan({
        name: "ppt-deck",
        version: "sv_01",
        entrypoint: "SKILL.md",
        installDir: "/skills/ppt-deck",
        fetchUrl: async () => "https://cache.example/skill.zip",
      }),
    ],
  });

  assert.equal(resolution?.ok, true);
  assert.equal(resolution?.rung, "fetch");
  assert.equal(resolution?.entrypointPath, "/skills/ppt-deck/SKILL.md");
  // Staging + promote target the fixed contract path, not the assets dir.
  assert.match(executed[0]!, /\/skills\/ppt-deck\.staging/u);
  assert.match(executed[0]!, /mv '\/skills\/ppt-deck\.staging' '\/skills\/ppt-deck'/u);
  assert.ok(files.get("/skills/ppt-deck/.sourceweft-asset.json"));
});

test("a version bump restages over the same installDir (stamp mismatch)", async () => {
  const files = new Map<string, Uint8Array>([
    [
      "/skills/ppt-deck/.sourceweft-asset.json",
      new TextEncoder().encode(
        JSON.stringify({ version: "sv_old", sha256: "b".repeat(64) }),
      ),
    ],
  ]);
  const { session, executed } = fakeSession({
    files,
    executeResults: [{ exitCode: 0 }],
  });

  const [resolution] = await ensureRuntimeAssets({
    session,
    assets: [
      plan({
        name: "ppt-deck",
        version: "sv_new",
        entrypoint: "SKILL.md",
        installDir: "/skills/ppt-deck",
        fetchUrl: async () => "https://cache.example/skill.zip",
      }),
    ],
  });

  assert.equal(resolution?.ok, true);
  assert.equal(resolution?.rung, "fetch");
  assert.equal(executed.length, 1);
  // A matching stamp resolves without staging; the mismatch restaged instead.
  const stamp = JSON.parse(
    new TextDecoder().decode(files.get("/skills/ppt-deck/.sourceweft-asset.json")!),
  ) as { version: string };
  assert.equal(stamp.version, "sv_new");
});

test("a matching stamp at installDir resolves without commands", async () => {
  const files = new Map<string, Uint8Array>([
    [
      "/skills/ppt-deck/.sourceweft-asset.json",
      new TextEncoder().encode(JSON.stringify({ version: "sv_01", sha256: SHA })),
    ],
  ]);
  const { session, executed } = fakeSession({ files });

  const [resolution] = await ensureRuntimeAssets({
    session,
    assets: [
      plan({
        name: "ppt-deck",
        version: "sv_01",
        entrypoint: "SKILL.md",
        installDir: "/skills/ppt-deck",
      }),
    ],
  });

  assert.equal(resolution?.ok, true);
  assert.equal(resolution?.rung, "stamp");
  assert.equal(resolution?.entrypointPath, "/skills/ppt-deck/SKILL.md");
  assert.equal(executed.length, 0);
});

test("unsafe install dirs are rejected before touching the session", async () => {
  const { session, executed } = fakeSession({});
  const resolutions = await ensureRuntimeAssets({
    session,
    assets: [
      plan({ installDir: "relative/path" }),
      plan({ installDir: "/" }),
      plan({ installDir: "/skills/x/" }),
      plan({ installDir: "/skills/../etc" }),
      plan({ installDir: "/skills/x'y" }),
      plan({ installDir: "/skills/x y" }),
    ],
  });
  assert.ok(resolutions.every((resolution) => !resolution.ok));
  assert.ok(
    resolutions.every((resolution) =>
      /unsafe install dir/u.test(resolution.error ?? ""),
    ),
  );
  assert.equal(executed.length, 0);
});

test("a presigned URL containing a single quote is refused", async () => {
  const { session, executed } = fakeSession({});
  const [resolution] = await ensureRuntimeAssets({
    session,
    assets: [plan({ fetchUrl: async () => "https://x/'$(rm -rf /)'" })],
  });
  assert.equal(resolution?.ok, false);
  assert.match(resolution?.error ?? "", /single quote/u);
  assert.equal(executed.length, 0);
});
