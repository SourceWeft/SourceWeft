import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistryClient } from "../src/registry/client";
import { installCommand } from "../src/commands/skills";
import { removeCommand, updateCommand } from "../src/commands/manage";
import { resolveInstallReference } from "../src/commands/resolve";
import { sha256 } from "@sourceweft/skill-format";

const body = "---\nname: writer\ndescription: Write prose\n---\nWrite prose.";
const detail = {
  skill: {
    slug: "gh-acme-tools-writer",
    installRef: "@acme/writer",
    name: "writer",
    displayName: "Writer",
    description: "Write prose",
    verified: false,
    capability: "prompt-only",
    license: "MIT",
    version: "a".repeat(40),
  },
  source: {
    repoUrl: "https://github.com/acme/tools",
    sourceUrl: null,
    commitSha: "a".repeat(40),
    repoSubpath: "skills/writer",
  },
  files: [
    {
      path: "SKILL.md",
      sizeBytes: Buffer.byteLength(body),
      contentHash: sha256(body),
    },
  ],
  scanFlags: [],
};
const candidate = {
  slug: detail.skill.slug,
  installRef: detail.skill.installRef,
  name: "writer",
  repoUrl: detail.source.repoUrl,
  repoSubpath: detail.source.repoSubpath,
  description: "Write prose",
};
const download = async () => new Map([["SKILL.md", Buffer.from(body)]]);
function client(items = [candidate]) {
  return createRegistryClient("https://registry.example", async (url) =>
    Response.json(
      String(url).includes("/resolve?") ? { items, exact: true } : detail,
    ),
  );
}

test("scoped and repository references preserve the canonical source and legacy slug", async () => {
  const requests: string[] = [];
  const api = createRegistryClient("https://registry.example", async (url) => {
    requests.push(String(url));
    return Response.json(
      String(url).includes("/resolve?")
        ? { items: [candidate], exact: true }
        : detail,
    );
  });
  assert.equal(
    (await resolveInstallReference(api, "@acme/writer")).skill.slug,
    detail.skill.slug,
  );
  await resolveInstallReference(api, "acme/tools", {
    skill: "writer",
    path: "skills/writer",
  });
  assert.ok(
    requests.some(
      (url) =>
        url.includes("skill=writer") && url.includes("path=skills%2Fwriter"),
    ),
  );
  requests.length = 0;
  await resolveInstallReference(api, detail.skill.slug);
  assert.equal(requests.length, 1);
  assert.ok(!requests[0]!.includes("resolve?"));
});

test("ambiguous --yes installs print exact choices and write no files", async () => {
  const root = await mkdtemp(join(tmpdir(), "sw-ref-ambiguous-"));
  let downloads = 0;
  try {
    await assert.rejects(
      installCommand(
        {
          client: client([
            candidate,
            {
              ...candidate,
              slug: "other",
              installRef: "@acme/writer-figquery",
              repoSubpath: "figquery/writer",
            },
          ]),
          registry: "https://registry.example",
          json: false,
          out: () => {},
          download: async () => {
            downloads++;
            return download();
          },
        },
        {
          slug: "@acme/writer",
          agents: ["claude-code"],
          scope: "user",
          dir: root,
          force: false,
          yes: true,
        },
      ),
      /writer-figquery/,
    );
    assert.equal(downloads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install, update and offline remove share the stored alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "sw-ref-lifecycle-"));
  const api = client();
  try {
    await installCommand(
      {
        client: api,
        registry: "https://registry.example",
        json: true,
        out: () => {},
        download,
      },
      {
        slug: "@acme/writer",
        agents: ["claude-code"],
        scope: "user",
        dir: root,
        force: false,
        yes: true,
      },
    );
    const metadata = JSON.parse(
      await readFile(join(root, "writer/.sourceweft.json"), "utf8"),
    );
    assert.equal(metadata.installRef, "@acme/writer");
    assert.equal(metadata.slug, detail.skill.slug);
    await updateCommand(
      { json: true, out: () => {}, clientFor: () => api, download },
      { slug: "@acme/writer", dir: root },
      { dryRun: true, force: false, yes: true },
    );
    await removeCommand(
      {
        json: false,
        out: () => {},
        clientFor: () => {
          throw new Error("remove must use its stored alias offline");
        },
      },
      { slug: "@acme/writer", dir: root },
      { force: false, yes: true },
    );
    await assert.rejects(readFile(join(root, "writer/SKILL.md")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolution cannot swap the pinned source between lookup and detail", async () => {
  const api = createRegistryClient("https://registry.example", async (url) =>
    Response.json(
      String(url).includes("/resolve?")
        ? { items: [candidate], exact: true }
        : {
            ...detail,
            source: { ...detail.source, repoSubpath: "other/writer" },
          },
    ),
  );
  await assert.rejects(
    resolveInstallReference(api, "@acme/writer"),
    /source changed/,
  );
});

test("legacy install metadata can update and remove through the registry alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "sw-ref-legacy-"));
  const api = client();
  try {
    await installCommand(
      {
        client: api,
        registry: "https://registry.example",
        json: true,
        out: () => {},
        download,
      },
      {
        slug: detail.skill.slug,
        agents: ["claude-code"],
        scope: "user",
        dir: root,
        force: false,
        yes: true,
      },
    );
    const path = join(root, "writer/.sourceweft.json");
    const metadata = JSON.parse(await readFile(path, "utf8"));
    delete metadata.installRef;
    await writeFile(path, JSON.stringify(metadata));
    const ctx = { json: true, out: () => {}, clientFor: () => api, download };
    await updateCommand(
      ctx,
      { slug: "@acme/writer", dir: root },
      { dryRun: true, force: false, yes: true },
    );
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).slug,
      detail.skill.slug,
    );
    await removeCommand(
      ctx,
      { slug: "@acme/writer", dir: root },
      { force: false, yes: true },
    );
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a name query cannot masquerade as a bound alias even with one public candidate", async () => {
  const api = createRegistryClient("https://registry.example", async () =>
    Response.json({ items: [candidate], exact: false }),
  );
  await assert.rejects(
    resolveInstallReference(api, "@acme/writer"),
    /alias is not assigned/,
  );
});
