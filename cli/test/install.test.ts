import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { sha256 } from "@sourceweft/skill-format";
import {
  AGENTS,
  findAgent,
  resolveSkillsRoot,
  resolveTargets,
} from "../src/install/agents";
import {
  detectLocalChanges,
  METADATA_FILE,
  parseMetadata,
  readMetadata,
  serializeMetadata,
  type InstalledMetadata,
} from "../src/install/metadata";
import {
  checkManifest,
  VerificationError,
  verifyFiles,
  type ManifestFile,
} from "../src/install/verify";
import { InstallConflictError, writeSkillDir } from "../src/install/write";
import { linkOrSkip } from "./links";

const enc = new TextEncoder();
const bytes = (text: string) => enc.encode(text);

function manifestOf(files: Record<string, string>): ManifestFile[] {
  return Object.entries(files).map(([path, text]) => ({
    path,
    sizeBytes: bytes(text).byteLength,
    contentHash: sha256(bytes(text)),
  }));
}

function downloadOf(files: Record<string, string>) {
  return new Map(
    Object.entries(files).map(([path, text]) => [path, bytes(text)]),
  );
}

const FILES = { "SKILL.md": "# pdf", "scripts/run.sh": "echo hi" };

function metadataFor(
  files: Record<string, string>,
  over: Partial<InstalledMetadata> = {},
): InstalledMetadata {
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
    ...over,
  };
}

const verifiedOf = (files: Record<string, string>) =>
  Object.entries(files).map(([path, text]) => ({ path, bytes: bytes(text) }));

describe("verifyFiles", () => {
  it("returns the manifest's files, in manifest order, when every hash matches", () => {
    const verified = verifyFiles(
      manifestOf(FILES),
      downloadOf({ ...FILES, "extra.txt": "not in manifest" }),
    );
    assert.deepEqual(
      verified.map((f) => f.path),
      ["SKILL.md", "scripts/run.sh"],
    );
  });

  it("does not install files the record does not list", () => {
    const verified = verifyFiles(
      manifestOf(FILES),
      downloadOf({ ...FILES, "evil.sh": "x" }),
    );
    assert.equal(
      verified.some((f) => f.path === "evil.sh"),
      false,
    );
  });

  it("names every way the download differs, and installs nothing", () => {
    const manifest = manifestOf({
      "SKILL.md": "# pdf",
      "a.md": "aaa",
      "b.md": "bbb",
      "c.md": "ccc",
    });
    const download = downloadOf({
      "SKILL.md": "# pdf",
      "a.md": "AAA",
      "b.md": "b",
    });
    assert.throws(
      () => verifyFiles(manifest, download),
      (error) =>
        error instanceof VerificationError &&
        error.problems.some(
          (p) => p.kind === "hash-mismatch" && p.path === "a.md",
        ) &&
        error.problems.some(
          (p) => p.kind === "size-mismatch" && p.path === "b.md",
        ) &&
        error.problems.some((p) => p.kind === "missing" && p.path === "c.md"),
    );
  });

  it("catches a same-size, different-content swap by hash", () => {
    assert.throws(
      () =>
        verifyFiles(
          manifestOf({ "SKILL.md": "abc" }),
          downloadOf({ "SKILL.md": "abd" }),
        ),
      (error) =>
        error instanceof VerificationError &&
        error.problems[0]?.kind === "hash-mismatch",
    );
  });
});

describe("checkManifest", () => {
  const kinds = (files: Record<string, string>) =>
    checkManifest(manifestOf(files)).map((p) => p.kind);

  it("accepts a clean manifest", () => {
    assert.deepEqual(kinds(FILES), []);
  });

  it("refuses unsafe paths, case collisions, a missing SKILL.md and the reserved file", () => {
    assert.ok(kinds({ "SKILL.md": "x", "../x": "y" }).includes("unsafe-path"));
    assert.ok(
      kinds({ "SKILL.md": "x", "a/B.md": "1", "a/b.md": "2" }).includes(
        "case-collision",
      ),
    );
    assert.ok(kinds({ "README.md": "x" }).includes("missing-skill-md"));
    assert.ok(
      kinds({ "SKILL.md": "x", [METADATA_FILE]: "{}" }).includes(
        "reserved-name",
      ),
    );
  });
});

describe("metadata", () => {
  it("round-trips", () => {
    const metadata = metadataFor(FILES);
    assert.deepEqual(parseMetadata(serializeMetadata(metadata)), metadata);
  });

  it("rejects anything that is not a well-formed record of ours", () => {
    for (const raw of [
      "",
      "nope",
      "[]",
      "{}",
      '{"schema":2}',
      JSON.stringify({ ...metadataFor(FILES), files: { a: 1 } }),
      JSON.stringify({ ...metadataFor(FILES), installedVia: "web" }),
    ]) {
      assert.equal(parseMetadata(raw), null, raw);
    }
  });
});

describe("writeSkillDir", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "sw-cli-"));
  });
  after(() => rm(root, { recursive: true, force: true }));

  const skillsRoot = (label: string) => join(root, label);

  it("writes the files and the metadata, and leaves no staging directory", async () => {
    const dest = skillsRoot("fresh");
    const result = await writeSkillDir({
      root: dest,
      name: "pdf",
      files: verifiedOf(FILES),
      metadata: metadataFor(FILES),
    });
    assert.equal(result.replaced, false);
    assert.equal(
      await readFile(join(result.dir, "scripts", "run.sh"), "utf8"),
      "echo hi",
    );
    assert.equal((await readMetadata(result.dir))?.slug, "pdf");
    assert.deepEqual(await readdir(dest), ["pdf"]);
  });

  it("replaces an unedited install of the same skill", async () => {
    const dest = skillsRoot("update");
    await writeSkillDir({
      root: dest,
      name: "pdf",
      files: verifiedOf(FILES),
      metadata: metadataFor(FILES),
    });
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
    await assert.rejects(readFile(join(dest, "pdf", "scripts", "run.sh")));
    assert.deepEqual(await readdir(dest), ["pdf"]);
  });

  it("refuses a directory it did not create, even with force", async () => {
    const dest = skillsRoot("foreign");
    await mkdir(join(dest, "pdf"), { recursive: true });
    await writeFile(join(dest, "pdf", "SKILL.md"), "mine");
    for (const force of [false, true]) {
      await assert.rejects(
        writeSkillDir({
          root: dest,
          name: "pdf",
          files: verifiedOf(FILES),
          metadata: metadataFor(FILES),
          force,
        }),
        (error) =>
          error instanceof InstallConflictError && error.code === "NOT_OURS",
      );
    }
    assert.equal(await readFile(join(dest, "pdf", "SKILL.md"), "utf8"), "mine");
  });

  it("refuses to overwrite a different skill or registry", async () => {
    const dest = skillsRoot("other");
    await writeSkillDir({
      root: dest,
      name: "pdf",
      files: verifiedOf(FILES),
      metadata: metadataFor(FILES, { slug: "other-skill" }),
    });
    await assert.rejects(
      writeSkillDir({
        root: dest,
        name: "pdf",
        files: verifiedOf(FILES),
        metadata: metadataFor(FILES),
        force: true,
      }),
      (error) =>
        error instanceof InstallConflictError && error.code === "OTHER_SOURCE",
    );
  });

  it("refuses to clobber local edits unless forced, and keeps the edits when refusing", async () => {
    const dest = skillsRoot("edited");
    await writeSkillDir({
      root: dest,
      name: "pdf",
      files: verifiedOf(FILES),
      metadata: metadataFor(FILES),
    });
    await writeFile(join(dest, "pdf", "SKILL.md"), "my edit");
    const next = { "SKILL.md": "# new" };
    await assert.rejects(
      writeSkillDir({
        root: dest,
        name: "pdf",
        files: verifiedOf(next),
        metadata: metadataFor(next),
      }),
      (error) =>
        error instanceof InstallConflictError &&
        error.code === "LOCALLY_MODIFIED",
    );
    assert.equal(
      await readFile(join(dest, "pdf", "SKILL.md"), "utf8"),
      "my edit",
    );
    await writeSkillDir({
      root: dest,
      name: "pdf",
      files: verifiedOf(next),
      metadata: metadataFor(next),
      force: true,
    });
    assert.equal(
      await readFile(join(dest, "pdf", "SKILL.md"), "utf8"),
      "# new",
    );
  });

  it("does not write through a symlink that stands where the skill goes", async (t) => {
    const dest = skillsRoot("linked");
    const outside = skillsRoot("outside");
    await mkdir(dest, { recursive: true });
    await mkdir(outside, { recursive: true });
    if (!(await linkOrSkip(t, outside, join(dest, "pdf")))) {
      return;
    }
    await assert.rejects(
      writeSkillDir({
        root: dest,
        name: "pdf",
        files: verifiedOf(FILES),
        metadata: metadataFor(FILES),
      }),
      (error) =>
        error instanceof InstallConflictError && error.code === "NOT_OURS",
    );
    assert.deepEqual(await readdir(outside), []);
  });

  it("rejects an unsafe skill name or file path before writing anything", async () => {
    const dest = skillsRoot("unsafe");
    await assert.rejects(
      writeSkillDir({
        root: dest,
        name: "../pdf",
        files: verifiedOf(FILES),
        metadata: metadataFor(FILES),
      }),
    );
    await assert.rejects(
      writeSkillDir({
        root: dest,
        name: "pdf",
        files: [{ path: "../escape", bytes: bytes("x") }],
        metadata: metadataFor(FILES),
      }),
    );
    await assert.rejects(readdir(join(dest, "pdf")));
    assert.deepEqual(
      (await readdir(dest)).filter((entry) => entry !== "pdf"),
      [],
    );
  });

  it("cleans up its staging directory when a write fails midway", async () => {
    const dest = skillsRoot("midway");
    await assert.rejects(
      writeSkillDir({
        root: dest,
        name: "pdf",
        files: [
          { path: "SKILL.md", bytes: bytes("ok") },
          { path: "SKILL.md", bytes: bytes("dup") },
        ],
        metadata: metadataFor(FILES),
      }),
    );
    assert.deepEqual(await readdir(dest), []);
  });
});

describe("detectLocalChanges", () => {
  it("reports edited, removed and added files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-cli-changes-"));
    try {
      await writeSkillDir({
        root: dir,
        name: "pdf",
        files: verifiedOf(FILES),
        metadata: metadataFor(FILES),
      });
      const installed = join(dir, "pdf");
      const metadata = (await readMetadata(installed))!;
      assert.deepEqual(await detectLocalChanges(installed, metadata), {
        modified: [],
        missing: [],
        added: [],
      });
      await writeFile(join(installed, "SKILL.md"), "edited");
      await rm(join(installed, "scripts", "run.sh"));
      await writeFile(join(installed, "notes.txt"), "mine");
      assert.deepEqual(await detectLocalChanges(installed, metadata), {
        modified: ["SKILL.md"],
        missing: ["scripts/run.sh"],
        added: ["notes.txt"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// `resolve` gives a drive-qualified path on Windows (`/h` becomes `C:\h`), so
// the expected values are built the same way instead of hard-coding a POSIX form.
const HOME = resolve("/h");
const PROJECT = resolve("/p");
const EXPLICIT = resolve("/x", "skills");

describe("agents", () => {
  it("resolves user, project and explicit directories", () => {
    const claude = findAgent("claude-code")!;
    assert.equal(
      resolveSkillsRoot({ agent: claude, scope: "user", home: HOME }),
      join(HOME, ".claude", "skills"),
    );
    assert.equal(
      resolveSkillsRoot({ agent: claude, scope: "project", cwd: PROJECT }),
      join(PROJECT, ".claude", "skills"),
    );
    assert.equal(
      resolveSkillsRoot({ agent: claude, scope: "user", dir: EXPLICIT }),
      EXPLICIT,
    );
    assert.equal(
      resolveSkillsRoot({
        agent: claude,
        scope: "user",
        dir: "rel",
        cwd: PROJECT,
      }),
      join(PROJECT, "rel"),
    );
  });

  it("has unique agent ids", () => {
    assert.equal(new Set(AGENTS.map((a) => a.id)).size, AGENTS.length);
    assert.equal(findAgent("nope"), undefined);
  });
});

describe("the agent table", () => {
  it("only names directories inside the home or project directory", () => {
    for (const agent of AGENTS) {
      for (const dir of [agent.userDir, agent.projectDir]) {
        assert.equal(isAbsolute(dir), false, `${agent.id}: ${dir}`);
        assert.equal(dir.includes("\\"), false, `${agent.id}: ${dir}`);
        assert.equal(
          dir.split("/").includes(".."),
          false,
          `${agent.id}: ${dir}`,
        );
        assert.equal(dir.split("/").at(-1), "skills", `${agent.id}: ${dir}`);
      }
    }
  });

  it("puts Codex, Goose and the shared directory in the same place", () => {
    const roots = ["codex", "goose", "universal"].map((id) =>
      resolveSkillsRoot({
        agent: findAgent(id)!,
        scope: "project",
        cwd: PROJECT,
      }),
    );
    assert.deepEqual(
      new Set(roots),
      new Set([join(PROJECT, ".agents", "skills")]),
    );
  });

  it("keeps each agent's own documented directory, not the shared one", () => {
    const at = (id: string, scope: "user" | "project") =>
      resolveSkillsRoot({
        agent: findAgent(id)!,
        scope,
        home: HOME,
        cwd: PROJECT,
      });
    assert.equal(at("cursor", "user"), join(HOME, ".cursor", "skills"));
    assert.equal(
      at("github-copilot", "project"),
      join(PROJECT, ".github", "skills"),
    );
    assert.equal(
      at("windsurf", "user"),
      join(HOME, ".codeium", "windsurf", "skills"),
    );
    assert.equal(
      at("opencode", "user"),
      join(HOME, ".config", "opencode", "skills"),
    );
    assert.equal(at("amp", "user"), join(HOME, ".config", "agents", "skills"));
  });
});

describe("resolveTargets", () => {
  it("installs once for agents that share a directory, and lists them all", () => {
    const targets = resolveTargets({
      agents: ["codex", "goose", "universal", "claude-code"].map((id) =>
        findAgent(id)!,
      ),
      scope: "user",
      home: HOME,
    });
    assert.equal(targets.length, 2);
    assert.deepEqual(
      targets[0]?.agents.map((a) => a.id),
      ["codex", "goose", "universal"],
    );
    assert.equal(targets[0]?.root, join(HOME, ".agents", "skills"));
  });

  it("gives an explicit directory to one place regardless of agent", () => {
    const targets = resolveTargets({
      agents: [findAgent("cursor")!],
      scope: "user",
      dir: EXPLICIT,
    });
    assert.deepEqual(
      targets.map((t) => t.root),
      [EXPLICIT],
    );
  });
});
