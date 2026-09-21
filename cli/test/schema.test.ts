import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { toFailure } from "../src/errors";
import {
  createRegistryClient,
  RegistryResponseError,
} from "../src/registry/client";

const HASH = "a".repeat(64);
const valid = {
  skill: {
    slug: "pdf",
    name: "pdf",
    displayName: "PDF",
    description: "PDFs",
    verified: false,
    capability: "prompt-only",
    license: null,
    version: "abc",
  },
  files: [{ path: "SKILL.md", sizeBytes: 3, contentHash: HASH }],
  source: {
    repoUrl: "https://github.com/acme/skills",
    sourceUrl: null,
    commitSha: "b".repeat(40),
    repoSubpath: "",
  },
  scanFlags: [],
};

async function getFrom(body: unknown) {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await createRegistryClient(url).getSkill("pdf");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe("the registry response the CLI accepts", () => {
  it("accepts fields it does not know, and keeps them for --json", async () => {
    const withExtras = {
      ...valid,
      skill: { ...valid.skill, logo: { dataUrl: "data:image/png;base64,AA" } },
      versions: [{ version: "abc" }],
      somethingNew: true,
    };
    const parsed = await getFrom(withExtras);
    assert.deepEqual(parsed, withExtras);
  });

  it("accepts a capability value a newer server invented", async () => {
    const parsed = await getFrom({
      ...valid,
      skill: { ...valid.skill, capability: "network" },
    });
    assert.equal(parsed.skill.capability, "network");
  });

  it("does not need the fields only the website reads", async () => {
    // No logo, categories, installCount, listedAt, versions, skillMd…
    await assert.doesNotReject(getFrom(valid));
  });

  it("still refuses what installing depends on, and says which field", async () => {
    for (const [label, body, mentions] of [
      [
        "a file with no hash",
        { ...valid, files: [{ path: "SKILL.md", sizeBytes: 3 }] },
        "contentHash",
      ],
      [
        "a malformed hash",
        {
          ...valid,
          files: [{ path: "SKILL.md", sizeBytes: 3, contentHash: "XYZ" }],
        },
        "contentHash",
      ],
      [
        "no commit field",
        {
          ...valid,
          source: { repoUrl: null, sourceUrl: null, repoSubpath: null },
        },
        "commitSha",
      ],
      ["no file list", { ...valid, files: undefined }, "files"],
    ] as const) {
      await assert.rejects(
        getFrom(body),
        (error) =>
          error instanceof RegistryResponseError &&
          error.message.includes(mentions) &&
          toFailure(error).exitCode === 1,
        label,
      );
    }
  });
});
