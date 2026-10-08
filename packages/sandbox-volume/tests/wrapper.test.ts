import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createVolumeHooks } from "../src/hooks/index";
import { parseCommandOutput } from "../src/protocol/marker";
import type { VolumeService } from "../src/service/volume-service";

const execute = promisify(execFile);
test("concurrent shell wrappers keep each flush report separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "swvol-wrapper-"));
  try {
    await mkdir(join(root, ".sourceweft"));
    const helper = join(root, "helper");
    await writeFile(
      helper,
      '#!/bin/sh\n[ "$1" = check ] && exit 0\nprintf \'{"ok":true,"seq":%s}\\n\' "$TEST_SEQ"\n[ "$TEST_SEQ" = 1 ] && sleep 0.15\nexit 0\n',
      { mode: 0o755 },
    );
    const hooks = createVolumeHooks({
      service: {} as VolumeService,
      helper: { imagePath: helper },
      root,
    });
    const results = await Promise.all(
      [1, 2].map(async (seq) => {
        const result = await execute(
          "/bin/sh",
          ["-c", hooks.wrapCommand("echo user-result")],
          { env: { ...process.env, TEST_SEQ: String(seq) } },
        );
        return parseCommandOutput(result.stdout);
      }),
    );
    assert.deepEqual(
      results.map((r) => r.flush?.seq),
      [1, 2],
    );
    assert.deepEqual(
      results.map((r) => r.output),
      ["user-result\n", "user-result\n"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
