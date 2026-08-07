import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import {
  createArchiveSizeLimitStream,
  inspectArchiveEntries,
} from "./github";

function runTar(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`tar exited with ${code}: ${stderr.trim()}`));
    });
  });
}

async function makeArchive(input: {
  build: (repoDir: string) => Promise<void>;
}): Promise<{ archivePath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "sourceweft-github-test-"));
  const repoDir = path.join(root, "repo");
  await mkdir(repoDir, { recursive: true });
  await input.build(repoDir);
  const archivePath = path.join(root, "repo.tar.gz");
  await runTar(["-czf", archivePath, "repo"], root);
  return {
    archivePath,
    cleanup: () => rm(root, { force: true, recursive: true }),
  };
}

describe("inspectArchiveEntries", () => {
  test("accepts a normal archive of plain files and directories", async () => {
    const { archivePath, cleanup } = await makeArchive({
      build: async (repoDir) => {
        await mkdir(path.join(repoDir, "sub"), { recursive: true });
        await writeFile(path.join(repoDir, "README.md"), "# ok\n");
        await writeFile(path.join(repoDir, "sub", "a.txt"), "a\n");
      },
    });
    try {
      await assert.doesNotReject(() => inspectArchiveEntries(archivePath));
    } finally {
      await cleanup();
    }
  });

  test("rejects archives containing a symlink", async () => {
    const { archivePath, cleanup } = await makeArchive({
      build: async (repoDir) => {
        await writeFile(path.join(repoDir, "a.txt"), "a\n");
        await symlink("a.txt", path.join(repoDir, "link.txt"));
      },
    });
    try {
      await assert.rejects(
        () => inspectArchiveEntries(archivePath),
        /symlink or hardlink/i,
      );
    } finally {
      await cleanup();
    }
  });

  test("rejects archives that exceed the file-count cap", async () => {
    const { archivePath, cleanup } = await makeArchive({
      build: async (repoDir) => {
        await writeFile(path.join(repoDir, "a.txt"), "a\n");
        await writeFile(path.join(repoDir, "b.txt"), "b\n");
        await writeFile(path.join(repoDir, "c.txt"), "c\n");
      },
    });
    try {
      await assert.rejects(
        () => inspectArchiveEntries(archivePath, { maxEntries: 2 }),
        /maximum allowed 2 files/i,
      );
    } finally {
      await cleanup();
    }
  });
});

describe("createArchiveSizeLimitStream", () => {
  test("rejects when the streamed bytes exceed the cap", async () => {
    await assert.rejects(
      () =>
        pipeline(
          Readable.from([Buffer.alloc(64), Buffer.alloc(64)]),
          createArchiveSizeLimitStream(100),
        ),
      /exceeds the maximum allowed size of 100 bytes/i,
    );
  });

  test("passes bytes through when under the cap", async () => {
    const collected: Buffer[] = [];
    await pipeline(
      Readable.from([Buffer.alloc(40), Buffer.alloc(40)]),
      createArchiveSizeLimitStream(100),
      async function (source) {
        for await (const chunk of source) {
          collected.push(chunk as Buffer);
        }
      },
    );
    assert.equal(
      collected.reduce((total, chunk) => total + chunk.length, 0),
      80,
    );
  });
});
