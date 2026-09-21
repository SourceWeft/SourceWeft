import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { describe, it } from "node:test";
import { sha256 } from "@sourceweft/skill-format";
import { agentsCommand } from "../src/commands/agents";
import { AGENTS, pathKey } from "../src/install/agents";
import type { InstalledMetadata } from "../src/install/metadata";
import { checkManifest } from "../src/install/verify";
import {
  renameWithRetry,
  resolveInside,
  writeSkillDir,
} from "../src/install/write";

/**
 * What differs between operating systems: name rules, path arithmetic, and
 * how a directory that is in use is replaced. Each test states which OS the
 * behaviour is for and runs on all of them, by injecting the platform where
 * the code takes one.
 */

const enc = new TextEncoder();
const bytes = (text: string) => enc.encode(text);
const FILES = { "SKILL.md": "# pdf", "scripts/run.sh": "echo hi" };

const verifiedOf = (files: Record<string, string>) =>
  Object.entries(files).map(([path, text]) => ({ path, bytes: bytes(text) }));

function metadataFor(files: Record<string, string>): InstalledMetadata {
  return {
    schema: 1,
    registry: "https://registry.example",
    slug: "pdf",
    version: "0123abc",
    source: {
      repoUrl: "https://github.com/acme/skills",
      commitSha: "a".repeat(40),
      subpath: "skills/pdf",
    },
    license: "MIT",
    files: Object.fromEntries(
      Object.entries(files).map(([path, text]) => [path, sha256(bytes(text))]),
    ),
    installedAt: "2026-09-21T00:00:00.000Z",
    installedVia: "cli",
  };
}

/**
 * `everywhere` is refused on every OS; `windowsOnly` is refused when writing on
 * Windows (they are ordinary names on macOS and Linux, which keep installing
 * them). The Windows-only rules are unit-tested with an explicit platform in
 * skill-format; these run the real chain on a real Windows runner.
 */
const HAZARDS = {
  everywhere: ["docs/nul.txt"],
  windowsOnly: [
    "SKILL.md:hidden",
    "SKILL.md::$DATA",
    "scripts/E:run.sh",
    "COM\u00b9",
    "a<b.md",
  ],
};
const NOT_WINDOWS =
  process.platform === "win32"
    ? false
    : "Windows-only rule; covered with an explicit platform in skill-format";

for (const [kind, hazards] of Object.entries(HAZARDS)) {
  describe(
    `Windows path hazards in a bundle (${kind})`,
    {
      skip: kind === "windowsOnly" ? NOT_WINDOWS : false,
    },
    () => {
      it("refuses them in the registry's record, before any download", () => {
        for (const path of hazards) {
          const problems = checkManifest([
            { path: "SKILL.md", sizeBytes: 1, contentHash: "0".repeat(64) },
            { path, sizeBytes: 1, contentHash: "0".repeat(64) },
          ]);
          assert.deepEqual(
            problems.map((p) => p.kind),
            ["unsafe-path"],
            path,
          );
        }
      });

      it("refuses to write them even if handed straight to the writer", async () => {
        const dest = await mkdtemp(join(tmpdir(), "sw-cli-hazard-"));
        try {
          for (const path of hazards) {
            await assert.rejects(
              writeSkillDir({
                root: dest,
                name: "pdf",
                files: [
                  ...verifiedOf({ "SKILL.md": "# pdf" }),
                  { path, bytes: bytes("x") },
                ],
                metadata: metadataFor({ "SKILL.md": "# pdf" }),
              }),
              /unsafe path/u,
              path,
            );
          }
          assert.deepEqual(await readdir(dest), []);
        } finally {
          await rm(dest, { recursive: true, force: true });
        }
      });
    },
  );
}

describe("resolveInside", () => {
  const base = resolve("/base", "skills");

  it("puts a bundle path under the root, whatever the separator", () => {
    assert.equal(resolveInside(base, "a/b/c.md"), join(base, "a", "b", "c.md"));
    assert.equal(resolveInside(base, "a"), join(base, "a"));
  });

  it("refuses anything that leaves the root", () => {
    for (const rel of ["..", "../x", "a/../../x", "a/b/../../.."]) {
      assert.throws(() => resolveInside(base, rel), /outside/u, rel);
    }
  });

  it("does not take a name that merely starts with two dots for an escape", () => {
    assert.equal(resolveInside(base, "..hidden"), join(base, "..hidden"));
  });

  it("works when the root is a filesystem root, which already ends in a separator", () => {
    const top = parse(base).root;
    assert.equal(resolveInside(top, "pdf"), join(top, "pdf"));
    // Nothing lies above a filesystem root, so `..` cannot climb out of it.
    assert.equal(resolveInside(top, "../x"), join(top, "x"));
  });
});

describe("renameWithRetry", () => {
  const failing = (failures: number, code: string) => {
    let calls = 0;
    const rename = async () => {
      calls += 1;
      if (calls <= failures) {
        throw Object.assign(new Error(code), { code });
      }
    };
    return { rename, calls: () => calls };
  };
  const quick = { delaysMs: [0, 0, 0] } as const;

  it("waits out a directory that is briefly held open on Windows", async () => {
    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
      const fake = failing(2, code);
      await renameWithRetry("a", "b", {
        ...quick,
        platform: "win32",
        rename: fake.rename,
      });
      assert.equal(fake.calls(), 3, code);
    }
  });

  it("gives up after a bounded number of tries and reports the error", async () => {
    const fake = failing(Infinity, "EBUSY");
    await assert.rejects(
      renameWithRetry("a", "b", {
        ...quick,
        platform: "win32",
        rename: fake.rename,
      }),
      { code: "EBUSY" },
    );
    assert.equal(fake.calls(), quick.delaysMs.length + 1);
  });

  it("does not retry other errors on Windows", async () => {
    const fake = failing(5, "ENOENT");
    await assert.rejects(
      renameWithRetry("a", "b", {
        ...quick,
        platform: "win32",
        rename: fake.rename,
      }),
      { code: "ENOENT" },
    );
    assert.equal(fake.calls(), 1);
  });

  it("does not retry anywhere else: there EPERM is a real refusal", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const fake = failing(5, "EPERM");
      await assert.rejects(
        renameWithRetry("a", "b", {
          ...quick,
          platform,
          rename: fake.rename,
        }),
        { code: "EPERM" },
      );
      assert.equal(fake.calls(), 1, platform);
    }
  });

  it("really renames a directory, with the defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-cli-rename-"));
    try {
      await mkdir(join(dir, "from"));
      await writeFile(join(dir, "from", "f"), "x");
      await renameWithRetry(join(dir, "from"), join(dir, "to"));
      assert.equal(await readFile(join(dir, "to", "f"), "utf8"), "x");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("replacing an install whose old copy cannot be deleted", () => {
  // Deleting the old copy needs write access to its directory; take that away.
  // Root ignores permissions, and Windows has no such bits, so neither can
  // stage the failure this way.
  const cannotStage =
    process.platform === "win32" || process.getuid?.() === 0
      ? "needs a POSIX filesystem and a non-root user to make a directory undeletable"
      : false;

  it(
    "still reports the install as done, and leaves the old copy for doctor",
    { skip: cannotStage },
    async () => {
      const dest = await mkdtemp(join(tmpdir(), "sw-cli-stale-"));
      let oldCopy: string | undefined;
      try {
        await writeSkillDir({
          root: dest,
          name: "pdf",
          files: verifiedOf(FILES),
          metadata: metadataFor(FILES),
        });
        await chmod(join(dest, "pdf"), 0o555);
        const next = { "SKILL.md": "# pdf v2" };
        const result = await writeSkillDir({
          root: dest,
          name: "pdf",
          files: verifiedOf(next),
          metadata: metadataFor(next),
        });
        assert.equal(result.replaced, true);
        assert.equal(
          await readFile(join(dest, "pdf", "SKILL.md"), "utf8"),
          "# pdf v2",
        );
        const left = (await readdir(dest)).filter((n) => n !== "pdf");
        assert.equal(left.length, 1);
        assert.match(left[0]!, /^\.sourceweft-tmp-.*\.old$/u);
        oldCopy = join(dest, left[0]!);
      } finally {
        if (oldCopy) {
          await chmod(oldCopy, 0o755);
        }
        await rm(dest, { recursive: true, force: true });
      }
    },
  );
});

describe("comparing paths", () => {
  it("ignores case on Windows and nowhere else", () => {
    assert.equal(
      pathKey("C:\\Users\\Me\\.agents", "win32"),
      pathKey("c:\\users\\me\\.agents", "win32"),
    );
    for (const platform of ["linux", "darwin"] as const) {
      assert.notEqual(
        pathKey("/Users/Me/.agents", platform),
        pathKey("/users/me/.agents", platform),
      );
    }
  });
});

describe("the agents command", () => {
  const run = (json: boolean) => {
    const lines: string[] = [];
    agentsCommand({ json, out: (l) => lines.push(l) });
    return lines.join("\n");
  };

  it("shows every directory `~/`-relative with forward slashes", () => {
    const text = run(false);
    assert.match(
      text,
      /^claude-code\s+~\/\.claude\/skills\s+\.claude\/skills\b/mu,
    );
    assert.match(text, /~\/\.config\/opencode\/skills/u);
    assert.doesNotMatch(text, /\\/u);
  });

  it("gives the same directories in JSON on every OS", () => {
    const listed = JSON.parse(run(true)) as typeof AGENTS;
    assert.equal(
      listed.find((a) => a.id === "windsurf")?.userDir,
      ".codeium/windsurf/skills",
    );
    for (const agent of listed) {
      assert.doesNotMatch(agent.userDir + agent.projectDir, /\\/u);
    }
  });
});
