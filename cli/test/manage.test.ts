import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { SkillResponse } from "../src/registry/schema";
import { sha256 } from "@sourceweft/skill-format";
import { strToU8, zipSync } from "fflate";
import {
  doctorCommand,
  listCommand,
  removeCommand,
  updateCommand,
  type ManageContext,
} from "../src/commands/manage";
import { ConfirmationRequiredError, EXIT, toFailure } from "../src/errors";
import { installFromRegistry } from "../src/install/install-skill";
import {
  findVersionSkew,
  scanRoots,
  selectRoots,
} from "../src/install/inventory";
import { createRegistryClient } from "../src/registry/client";
import { fetchSkillFiles } from "../src/source/github";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const V1 = { "SKILL.md": "# pdf v1\n", "scripts/run.sh": "echo 1\n" };
const V2 = { "SKILL.md": "# pdf v2\n", "scripts/run.sh": "echo 2\n" };

const archiveFor = (sha: string, files: Record<string, string>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, text]) => [
        `skills-${sha}/skills/pdf/${path}`,
        strToU8(text),
      ]),
    ),
  );

const ARCHIVES: Record<string, Uint8Array> = {
  [SHA_A]: archiveFor(SHA_A, V1),
  [SHA_B]: archiveFor(SHA_B, V2),
};

function response(
  sha: string,
  files: Record<string, string>,
  name = "pdf",
): SkillResponse {
  return {
    skill: {
      slug: "pdf",
      name,
      displayName: "PDF",
      description: "PDFs",
      categories: [],
      verified: false,
      capability: "executable",
      license: "MIT",
      author: "acme",
      repoUrl: "https://github.com/acme/skills",
      sourceUrl: null,
      installCount: 0,
      listedAt: "2026-09-01T00:00:00.000Z",
      version: sha.slice(0, 7),
      updatedAt: null,
    },
    skillMd: files["SKILL.md"] ?? null,
    files: Object.entries(files).map(([path, text]) => ({
      path,
      sizeBytes: strToU8(text).byteLength,
      mimeType: null,
      contentHash: sha256(text),
    })),
    versions: [],
    source: {
      repoUrl: "https://github.com/acme/skills",
      sourceUrl: null,
      commitSha: sha,
      committedAt: null,
      repoSubpath: "skills/pdf",
    },
    scanFlags: [],
  };
}

describe("managing installed skills", () => {
  let registryServer: Server;
  let githubServer: Server;
  let registry = "";
  let githubBase = "";
  let work: string;
  let root: string;
  let latest: SkillResponse | null;
  const lines: string[] = [];

  before(async () => {
    registryServer = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      if (!latest) {
        res.statusCode = 404;
        res.end(JSON.stringify({ code: "NOT_FOUND", message: "nope" }));
        return;
      }
      res.end(JSON.stringify(latest));
    });
    githubServer = createServer((req, res) => {
      const sha = req.url?.split("/").pop() ?? "";
      const body = ARCHIVES[sha];
      if (!body) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.end(Buffer.from(body));
    });
    await Promise.all([
      new Promise<void>((r) => registryServer.listen(0, "127.0.0.1", r)),
      new Promise<void>((r) => githubServer.listen(0, "127.0.0.1", r)),
    ]);
    registry = `http://127.0.0.1:${(registryServer.address() as AddressInfo).port}`;
    githubBase = `http://127.0.0.1:${(githubServer.address() as AddressInfo).port}`;
    work = await mkdtemp(join(tmpdir(), "sw-cli-manage-"));
  });
  after(async () => {
    await Promise.all([
      new Promise((r) => registryServer.close(r)),
      new Promise((r) => githubServer.close(r)),
    ]);
    await rm(work, { recursive: true, force: true });
  });

  const download: typeof fetchSkillFiles = (source, archive, options) =>
    fetchSkillFiles(source, archive, { ...options, baseUrl: githubBase });
  const ctx = (json = false): ManageContext => ({
    json,
    out: (l) => lines.push(l),
    clientFor: (r) => createRegistryClient(r),
    download,
  });
  const out = () => lines.join("\n");
  const skillDir = () => join(root, "pdf");

  let counter = 0;
  beforeEach(async () => {
    lines.length = 0;
    root = join(work, `root-${(counter += 1)}`);
    latest = response(SHA_A, V1);
    await installFromRegistry({
      skill: response(SHA_A, V1),
      registry,
      root,
      download,
    });
  });

  it("lists what it installed, and nothing it did not", async () => {
    await mkdir(join(root, "hand-made"), { recursive: true });
    await writeFile(join(root, "hand-made", "SKILL.md"), "mine");
    await listCommand(ctx(), { dir: root });
    assert.match(out(), /^pdf\s+aaaaaaa\s+custom\/user\s+/mu);
    assert.doesNotMatch(out(), /hand-made/u);
    lines.length = 0;
    await listCommand(ctx(true), { dir: root });
    assert.deepEqual(
      JSON.parse(out()).map((s: { slug: string }) => s.slug),
      ["pdf"],
    );
    lines.length = 0;
    await listCommand(ctx(), { dir: join(work, "empty") });
    assert.equal(out(), "No skills installed by sourceweft.");
  });

  it("flags edited, missing and extra files in the listing", async () => {
    await writeFile(join(skillDir(), "notes.txt"), "mine");
    await listCommand(ctx(), { dir: root });
    assert.match(out(), /extra files/u);
    await writeFile(join(skillDir(), "SKILL.md"), "edited");
    lines.length = 0;
    await listCommand(ctx(), { dir: root });
    assert.match(out(), /modified/u);
    await rm(join(skillDir(), "scripts", "run.sh"));
    lines.length = 0;
    await listCommand(ctx(), { dir: root });
    assert.match(out(), /files missing/u);
  });

  it("does not treat a symlink at a skill's place as an install", async () => {
    await symlink(skillDir(), join(root, "alias"));
    const { skills } = await scanRoots(selectRoots({ dir: root }));
    assert.deepEqual(
      skills.map((s) => s.name),
      ["pdf"],
    );
  });

  describe("update", () => {
    it("reports up to date when the commit has not moved", async () => {
      await updateCommand(
        ctx(),
        { dir: root },
        { dryRun: false, force: false, yes: true },
      );
      assert.match(out(), /pdf: up to date/u);
    });

    it("--dry-run reports the update and changes nothing", async () => {
      latest = response(SHA_B, V2);
      await updateCommand(
        ctx(),
        { dir: root },
        { dryRun: true, force: false, yes: true },
      );
      assert.match(out(), /update available \(bbbbbbb\)/u);
      assert.equal(
        await readFile(join(skillDir(), "SKILL.md"), "utf8"),
        V1["SKILL.md"],
      );
    });

    it("updates to the registry's commit, verified, and records it", async () => {
      latest = response(SHA_B, V2);
      await updateCommand(
        ctx(),
        { dir: root, slug: "pdf" },
        { dryRun: false, force: false, yes: true },
      );
      assert.match(out(), /pdf: updated to bbbbbbb/u);
      assert.equal(
        await readFile(join(skillDir(), "scripts", "run.sh"), "utf8"),
        V2["scripts/run.sh"],
      );
      const { skills } = await scanRoots(selectRoots({ dir: root }));
      assert.equal(skills[0]?.metadata.source.commitSha, SHA_B);
      assert.deepEqual(skills[0]?.changes, {
        modified: [],
        missing: [],
        added: [],
      });
    });

    it("asks first, and without a terminal or --yes updates nothing", async () => {
      latest = response(SHA_B, V2);
      await assert.rejects(
        updateCommand(
          ctx(),
          { dir: root },
          { dryRun: false, force: false, yes: false },
        ),
        ConfirmationRequiredError,
      );
      assert.equal(
        await readFile(join(skillDir(), "SKILL.md"), "utf8"),
        V1["SKILL.md"],
      );
    });

    it("will not destroy local edits or added files unless forced", async () => {
      latest = response(SHA_B, V2);
      await writeFile(join(skillDir(), "notes.txt"), "my notes");
      await assert.rejects(
        updateCommand(
          ctx(),
          { dir: root },
          { dryRun: false, force: false, yes: true },
        ),
        (error) => toFailure(error).message.includes("local changes"),
      );
      assert.equal(
        await readFile(join(skillDir(), "notes.txt"), "utf8"),
        "my notes",
      );
      await updateCommand(
        ctx(),
        { dir: root },
        { dryRun: false, force: true, yes: true },
      );
      assert.equal(
        await readFile(join(skillDir(), "SKILL.md"), "utf8"),
        V2["SKILL.md"],
      );
    });

    it("leaves a skill installed when the registry no longer has it", async () => {
      latest = null;
      await updateCommand(
        ctx(),
        { dir: root },
        { dryRun: false, force: false, yes: true },
      );
      assert.match(out(), /no longer in the registry \(left installed\)/u);
      assert.equal(
        await readFile(join(skillDir(), "SKILL.md"), "utf8"),
        V1["SKILL.md"],
      );
    });

    it("does not update in place a skill whose name changed", async () => {
      latest = response(SHA_B, V2, "pdf-tools");
      await updateCommand(
        ctx(),
        { dir: root },
        { dryRun: false, force: false, yes: true },
      );
      assert.match(out(), /now named 'pdf-tools'/u);
      assert.deepEqual((await readdir(root)).sort(), ["pdf"]);
    });
  });

  describe("remove", () => {
    it("removes only that skill's directory", async () => {
      await mkdir(join(root, "hand-made"));
      await removeCommand(
        ctx(),
        { dir: root, slug: "pdf" },
        { force: false, yes: true },
      );
      assert.deepEqual(await readdir(root), ["hand-made"]);
    });

    it("refuses one that is not installed, and one with changes unless forced", async () => {
      await assert.rejects(
        removeCommand(
          ctx(),
          { dir: root, slug: "nope" },
          { force: false, yes: true },
        ),
        (e) => toFailure(e).exitCode === EXIT.usage,
      );
      await writeFile(join(skillDir(), "notes.txt"), "mine");
      await assert.rejects(
        removeCommand(
          ctx(),
          { dir: root, slug: "pdf" },
          { force: false, yes: true },
        ),
        (e) => toFailure(e).message.includes("--force"),
      );
      assert.deepEqual((await readdir(root)).sort(), ["pdf"]);
      await removeCommand(
        ctx(),
        { dir: root, slug: "pdf" },
        { force: true, yes: true },
      );
      assert.deepEqual(await readdir(root), []);
    });

    it("asks first, and without a terminal or --yes removes nothing", async () => {
      await assert.rejects(
        removeCommand(
          ctx(),
          { dir: root, slug: "pdf" },
          { force: false, yes: false },
        ),
        ConfirmationRequiredError,
      );
      assert.deepEqual(await readdir(root), ["pdf"]);
    });

    it("re-checks at deletion time: a link swapped in since the scan is not followed", async () => {
      const outside = join(work, `outside-${counter}`);
      await mkdir(outside);
      await writeFile(join(outside, "precious"), "keep");
      const { skills } = await scanRoots(selectRoots({ dir: root }));
      await rm(skillDir(), { recursive: true });
      await symlink(outside, skillDir());
      const { removeInstalled } = await import("../src/install/inventory");
      await assert.rejects(removeInstalled(skills[0]!, { force: true }));
      assert.equal(await readFile(join(outside, "precious"), "utf8"), "keep");
    });
  });

  describe("doctor", () => {
    it("is quiet and exits 0 when everything is in order", async () => {
      assert.equal(await doctorCommand(ctx(), { dir: root }), 0);
      assert.match(out(), /^OK — 1 installed skill\(s\)/u);
    });

    it("exits 1 for a missing file, corrupt metadata and an interrupted install", async () => {
      await rm(join(skillDir(), "scripts", "run.sh"));
      await mkdir(join(root, "broken"));
      await writeFile(join(root, "broken", ".sourceweft.json"), "{nope");
      await mkdir(join(root, ".sourceweft-tmp-abc123"));
      assert.equal(await doctorCommand(ctx(), { dir: root }), 1);
      assert.match(out(), /'scripts\/run\.sh' is missing/u);
      assert.match(out(), /broken.*unreadable/u);
      assert.match(out(), /interrupted install/u);
    });

    it("only notes an edit, since that is the user's to make", async () => {
      await writeFile(join(skillDir(), "SKILL.md"), "edited");
      assert.equal(await doctorCommand(ctx(), { dir: root }), 0);
      assert.match(out(), /note\s+.*'SKILL.md' was edited/u);
    });

    it("finds the same skill installed at two versions", async () => {
      const other = join(work, `other-${counter}`);
      await installFromRegistry({
        skill: response(SHA_B, V2),
        registry,
        root: other,
        download,
      });
      const { skills } = await scanRoots([
        { agent: "claude-code", scope: "user", root },
        { agent: "universal", scope: "user", root: other },
      ]);
      assert.deepEqual([...findVersionSkew(skills).keys()], ["pdf"]);
    });
  });
});
