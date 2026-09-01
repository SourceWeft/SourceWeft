import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REMOTION_RENDERER_VERSION } from "../src/pipeline/renderer-version";

const repositoryFile = (relative: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../${relative}`, import.meta.url)),
    "utf8",
  );

test("both sandbox images prewarm the pinned trusted-render dependency store", () => {
  const installBase = repositoryFile(
    "docker/sourceweft-sandbox/install-base.sh",
  );
  assert.ok(
    installBase.includes(
      'REMOTION_RENDERER_VERSION="${REMOTION_RENDERER_VERSION:-' +
        REMOTION_RENDERER_VERSION +
        '}"',
    ),
  );
  assert.match(installBase, /sourceweft-video-render-cache/u);
  assert.match(installBase, /--store-dir "\$\{SOURCEWEFT_PNPM_STORE\}"/u);

  for (const dockerfile of [
    "docker/sourceweft-sandbox/Dockerfile",
    "packages/sandbox-provider-cloudflare/bridge/Dockerfile",
  ]) {
    assert.match(
      repositoryFile(dockerfile),
      /ENV SOURCEWEFT_PNPM_STORE=\/opt\/sourceweft-pnpm-store/u,
    );
  }
});
