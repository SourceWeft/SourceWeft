import assert from "node:assert/strict";
import { test } from "vitest";
import {
  REGISTRY_SERVER_PROVENANCE_LIMITS,
  registryServerProvenance,
} from "./registry-server";

test("nothing is kept without packages or remotes", () => {
  assert.equal(registryServerProvenance(null), undefined);
  assert.equal(registryServerProvenance("server"), undefined);
  assert.equal(registryServerProvenance({ name: "x" }), undefined);
  assert.equal(
    registryServerProvenance({ packages: "npm", remotes: [null, 3] }),
    undefined,
  );
});

test("inputs keep name, description, format and flags; values, defaults and hints go", () => {
  const kept = registryServerProvenance({
    packages: [
      {
        registryType: "pypi",
        registryBaseUrl: "https://pypi.org",
        identifier: "  weather-mcp  ",
        runtimeHint: "uvx",
        packageArguments: [{ name: "--key", value: "secret-arg" }],
        environmentVariables: [
          {
            name: "API_KEY",
            description: "  The   key.  ",
            format: "string",
            isRequired: true,
            isSecret: true,
            value: "secret-value",
            default: "secret-default",
            placeholder: "sk-...",
            valueHint: "hint",
            choices: ["a", "b"],
            variables: { inner: { name: "INNER", value: "secret-inner" } },
          },
          { description: "no name, dropped" },
          { name: "OPTIONAL", isRequired: false, isSecret: "yes" },
        ],
      },
    ],
  });
  assert.deepEqual(kept, {
    packages: [
      {
        registryType: "pypi",
        identifier: "weather-mcp",
        runtimeHint: "uvx",
        environmentVariables: [
          {
            name: "API_KEY",
            description: "The key.",
            format: "string",
            isRequired: true,
            isSecret: true,
          },
          { name: "OPTIONAL" },
        ],
      },
    ],
  });
  assert.equal(JSON.stringify(kept).includes("secret"), false);
});

test("a remote keeps its endpoint without credentials, query or fragment", () => {
  const kept = registryServerProvenance({
    remotes: [
      { type: "sse", url: "https://api.example.com/mcp/sse?token=abc#frag" },
      { type: "streamable-http", url: "https://user:pass@example.com/mcp" },
      { type: "streamable-http", url: "https://{tenant}.example.com/mcp?k=1" },
      { type: "streamable-http", url: "ftp://example.com/mcp" },
    ],
  });
  assert.deepEqual(kept, {
    remotes: [
      { type: "sse", url: "https://api.example.com/mcp/sse" },
      { type: "streamable-http" },
      { type: "streamable-http", url: "https://{tenant}.example.com/mcp" },
      { type: "streamable-http" },
    ],
  });
});

test("lists and strings are bounded", () => {
  const limits = REGISTRY_SERVER_PROVENANCE_LIMITS;
  const kept = registryServerProvenance({
    packages: Array.from({ length: limits.packages + 5 }, (_, index) => ({
      registryType: "npm",
      identifier: `pkg-${index}`,
      environmentVariables: Array.from(
        { length: limits.inputs + 5 },
        (_, inner) => ({
          name: `VAR_${inner}`,
          description: "x".repeat(limits.descriptionChars + 100),
        }),
      ),
    })),
  });
  assert.equal(kept?.packages?.length, limits.packages);
  const variables = kept!.packages![0]!.environmentVariables!;
  assert.equal(variables.length, limits.inputs);
  assert.equal(variables[0]!.description!.length, limits.descriptionChars);
});
