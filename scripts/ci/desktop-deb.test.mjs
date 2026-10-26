import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findDeb } from "./desktop-deb.mjs";

const ar = Buffer.concat([Buffer.from("!<arch>\n"), Buffer.alloc(16, 1)]);

async function withDirectory(fn) {
  const directory = await mkdtemp(join(tmpdir(), "desktop-deb-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("returns the single ar archive", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "SourceWeft_1.0.0_amd64.deb"), ar);
    await writeFile(join(directory, "ignored.txt"), "x");
    assert.equal(
      await findDeb(directory),
      join(directory, "SourceWeft_1.0.0_amd64.deb"),
    );
  }));

test("rejects zero or several packages", () =>
  withDirectory(async (directory) => {
    await assert.rejects(findDeb(directory), /exactly one \.deb/);
    await writeFile(join(directory, "a.deb"), ar);
    await writeFile(join(directory, "b.deb"), ar);
    await assert.rejects(findDeb(directory), /exactly one \.deb/);
  }));

test("rejects files that are not Debian archives", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "a.deb"), "not an archive at all");
    await assert.rejects(findDeb(directory), /Debian ar archive/);
    await writeFile(join(directory, "a.deb"), Buffer.alloc(0));
    await assert.rejects(findDeb(directory), /Debian ar archive/);
    await writeFile(join(directory, "a.deb"), "!<arch>\n");
    await assert.rejects(findDeb(directory), /cannot be empty/);
  }));

test("rejects symbolic links", () =>
  withDirectory(async (directory) => {
    await writeFile(join(directory, "real"), ar);
    await symlink(join(directory, "real"), join(directory, "a.deb"));
    await assert.rejects(findDeb(directory), /regular file/);
  }));
