import assert from "node:assert/strict";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

// The Linux release builds an AppImage and a .deb in separate bundle directories. The .deb
// carries the sandbox setup (bubblewrap copy + AppArmor profile) and is published next to the
// AppImage on the GitHub release only; it is not part of the download page or update manifests.
export async function findDeb(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const debs = entries.filter((entry) => entry.name.endsWith(".deb"));
  assert.equal(debs.length, 1, "Expected exactly one .deb package");
  const [deb] = debs;
  assert(deb.isFile() && !deb.isSymbolicLink(), ".deb must be a regular file");
  const path = join(directory, deb.name);
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    assert(
      bytesRead === 8 && header.equals(Buffer.from("!<arch>\n", "latin1")),
      "Expected a Debian ar archive",
    );
    assert((await file.stat()).size > 8, ".deb cannot be empty");
  } finally {
    await file.close();
  }
  return path;
}
