import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  normaliseLanguage,
  normaliseLicense,
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

  test("the repository URL falls back to the registry's provenance when the row has none, or an empty one", () => {
    const provenance = {
      ...github(),
      repository: { url: "https://github.com/acme/server" },
    };
    for (const repoUrl of [null, "", "  "]) {
      assert.equal(resolve({ provenance, repoUrl }).license, "MIT", `repoUrl ${JSON.stringify(repoUrl)}`);
    }
    // Without either, nothing ties the record to the entry.
    assert.equal(resolve({ provenance: github(), repoUrl: null }).license, null);
    assert.equal(resolve({ provenance: github(), repoUrl: "" }).license, null);
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

describe("normalising the values", () => {
  test("common long names map to their SPDX id", () => {
    for (const [given, expected] of [
      ["MIT License", "MIT"],
      ["  mit  ", "MIT"],
      ["Apache License 2.0", "Apache-2.0"],
      ["Apache 2.0", "Apache-2.0"],
      ["BSD 3-Clause", "BSD-3-Clause"],
      ["GNU General Public License v3.0", "GPL-3.0"],
      ["The Unlicense", "Unlicense"],
      ["Apache-2.0", "Apache-2.0"],
      ["GPL-3.0-only", "GPL-3.0-only"],
      ["MIT OR Apache-2.0", "MIT OR Apache-2.0"],
    ] as const) {
      assert.equal(normaliseLicense(given), expected, given);
    }
  });

  test("placeholders and free text are no license", () => {
    for (const given of [
      "",
      "   ",
      "Unknown",
      "UNLICENSED",
      "NONE",
      "None",
      "Other",
      "N/A",
      "NOASSERTION",
      "SEE LICENSE IN LICENSE",
      "See LICENSE file",
      "Custom",
      "x".repeat(130),
      null,
      undefined,
      42,
    ]) {
      assert.equal(normaliseLicense(given), null, String(given));
    }
  });

  test("a language placeholder is no language", () => {
    assert.equal(normaliseLanguage(" TypeScript "), "TypeScript");
    for (const given of ["", "unknown", "None", "N/A", "Other", null, "x".repeat(70)]) {
      assert.equal(normaliseLanguage(given), null, String(given));
    }
  });

  test("every source is normalised, so one license reads alike and a placeholder never counts", () => {
    const registry = { githubRegistry: { license: "MIT License", matchedBy: "name" } };
    assert.equal(resolve({ provenance: registry }).license, "MIT");
    assert.equal(
      resolve({ manifest: { license: "SEE LICENSE IN LICENSE" }, provenance: {} }).license,
      null,
    );
    // A placeholder from a higher source does not hide a real value below it.
    const resolved = resolve({
      manifest: { license: "UNLICENSED", language: "Unknown" },
      provenance: { ...registry, ...github({ license: "NOASSERTION", language: "n/a" }) },
    });
    assert.deepEqual(
      [resolved.license, resolved.licenseSource, resolved.language],
      ["MIT", "github-registry", null],
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
