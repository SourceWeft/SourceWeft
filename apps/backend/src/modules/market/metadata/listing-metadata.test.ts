import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  repositoryMetadataFromGithub,
  resolveListingMetadata,
} from "./listing-metadata";

const OBSERVED = "2026-10-25T00:00:00.000Z";

const github = (over: Record<string, unknown> = {}) => ({
  repositoryMetadata: {
    repository: "acme/server",
    subfolder: "",
    license: "MIT",
    language: "TypeScript",
    observedAt: OBSERVED,
    ...over,
  },
});

const resolve = (input: {
  manifest?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  repoUrl?: string | null;
}) =>
  resolveListingMetadata({
    manifestJson: input.manifest ?? {},
    provenanceJson: input.provenance ?? {},
    repoUrl: input.repoUrl === undefined ? "https://github.com/acme/server" : input.repoUrl,
  });

describe("sources", () => {
  test("nothing known resolves to nothing", () => {
    const resolved = resolve({});
    assert.equal(resolved.license, null);
    assert.equal(resolved.language, null);
    assert.equal(resolved.hostedOnly, false);
  });

  test("GitHub's answer for the entry's repository", () => {
    const resolved = resolve({ provenance: github() });
    assert.deepEqual(
      [resolved.license, resolved.licenseSource, resolved.language, resolved.languageSource],
      ["MIT", "github", "TypeScript", "github"],
    );
  });

  test("GitHub wins over the package manifest, which wins over the registry row", () => {
    const registry = { githubRegistry: { license: "GPL-3.0", matchedBy: "name" } };
    assert.equal(
      resolve({
        manifest: { license: "Apache-2.0", language: "Python" },
        provenance: { ...github(), ...registry },
      }).license,
      "MIT",
    );
    const packaged = resolve({
      manifest: { license: "Apache-2.0", language: "Python" },
      provenance: registry,
    });
    assert.deepEqual(
      [packaged.license, packaged.licenseSource, packaged.language, packaged.languageSource],
      ["Apache-2.0", "package", "Python", "package"],
    );
    const registryOnly = resolve({ provenance: registry });
    assert.deepEqual([registryOnly.license, registryOnly.licenseSource], ["GPL-3.0", "github-registry"]);
  });

  test("a registry row matched by the endpoint's domain describes another repository", () => {
    assert.equal(
      resolve({
        provenance: { githubRegistry: { license: "MIT", matchedBy: "endpoint-domain-org" } },
      }).license,
      null,
    );
  });

  test("values read from another repository than the entry names now are ignored", () => {
    assert.equal(
      resolve({ provenance: github(), repoUrl: "https://github.com/acme/renamed" }).license,
      null,
    );
    assert.equal(resolve({ provenance: github(), repoUrl: null }).license, null);
    // Case does not matter on GitHub.
    assert.equal(
      resolve({ provenance: github(), repoUrl: "https://github.com/ACME/Server" }).license,
      "MIT",
    );
  });

  test("the repository URL falls back to the registry's provenance", () => {
    assert.equal(
      resolve({
        provenance: {
          ...github(),
          repository: { url: "https://github.com/acme/server" },
        },
        repoUrl: undefined,
      }).license,
      "MIT",
    );
  });

  test("a monorepo subfolder takes the repository's license but not its language", () => {
    const resolved = resolve({
      provenance: github({ subfolder: "src/everything" }),
    });
    assert.equal(resolved.license, "MIT");
    assert.equal(resolved.language, null);
    // The package manifest's own language still counts.
    assert.equal(
      resolve({
        manifest: { language: "Python" },
        provenance: github({ subfolder: "src/git" }),
      }).language,
      "Python",
    );
  });

  test("a malformed record is ignored", () => {
    assert.equal(
      resolve({ provenance: { repositoryMetadata: { license: 7 } } }).license,
      null,
    );
  });
});

describe("hosted services", () => {
  const hosted = {
    manifest: { endpointUrl: "https://mcp.notion.com/mcp", license: "MIT", language: "TypeScript" },
    provenance: {
      registryServer: { remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }] },
      githubRegistry: { license: "MIT", matchedBy: "name" },
      ...github(),
    },
    repoUrl: null as string | null,
  };

  test("a remote with no package and no repository has neither license nor language", () => {
    const resolved = resolve(hosted);
    assert.equal(resolved.hostedOnly, true);
    assert.equal(resolved.license, null);
    assert.equal(resolved.language, null);
  });

  test("a remote that also ships a package, or names a repository, is not hosted-only", () => {
    const withPackage = resolve({
      ...hosted,
      provenance: {
        ...hosted.provenance,
        registryServer: {
          remotes: [{ url: "https://x.example/mcp" }],
          packages: [{ registryType: "npm", identifier: "x" }],
        },
      },
    });
    assert.equal(withPackage.hostedOnly, false);
    assert.equal(withPackage.license, "MIT");
    assert.equal(
      resolve({ ...hosted, manifest: { ...hosted.manifest, repoUrl: "https://github.com/acme/server" } })
        .hostedOnly,
      false,
    );
  });

  test("an entry that says nothing about its delivery is not hosted-only", () => {
    assert.equal(
      resolve({ manifest: { endpointUrl: "https://x.example/mcp" } }).hostedOnly,
      false,
    );
  });
});

describe("repositoryMetadataFromGithub", () => {
  const base = {
    owner: "Acme",
    repo: "Server",
    subfolder: "",
    observedAt: new Date(OBSERVED),
  };

  test("keeps the SPDX id and the language, under a lower-case repository", () => {
    assert.deepEqual(
      repositoryMetadataFromGithub({
        ...base,
        licenseInfo: { spdxId: "Apache-2.0" },
        primaryLanguage: { name: "Go" },
      }),
      {
        repository: "acme/server",
        subfolder: "",
        license: "Apache-2.0",
        language: "Go",
        observedAt: OBSERVED,
      },
    );
  });

  test("NOASSERTION and missing values are left out", () => {
    const record = repositoryMetadataFromGithub({
      ...base,
      licenseInfo: { spdxId: "NOASSERTION" },
      primaryLanguage: null,
    });
    assert.equal("license" in record, false);
    assert.equal("language" in record, false);
    assert.equal(
      "license" in
        repositoryMetadataFromGithub({ ...base, licenseInfo: null, primaryLanguage: null }),
      false,
    );
  });
});
