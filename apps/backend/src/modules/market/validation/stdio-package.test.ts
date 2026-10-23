import assert from "node:assert/strict";
import { test } from "vitest";
import {
  argumentTokens,
  chooseStdioPackage,
  MCP_STDIO_FIXED_ENV,
  MCP_STDIO_INSTALL_TIMEOUT_MS,
  MCP_STDIO_PLACEHOLDER,
  MCP_STDIO_RUN_TIMEOUT_MS,
  pep503Name,
  placeholderEnvironment,
  shellQuote,
} from "./stdio-package";

test("an npm package becomes an npx install and start, pinned to its version", () => {
  const choice = chooseStdioPackage([
    {
      registryType: "npm",
      identifier: "@notionhq/notion-mcp-server",
      version: "1.8.1",
      runtimeHint: "npx",
      transport: { type: "stdio" },
      environmentVariables: [
        { name: "OPENAPI_MCP_HEADERS", isRequired: true, isSecret: true },
        { name: "NOTION_PAGE_ID" },
      ],
    },
  ]);
  assert.equal(choice.kind, "plan");
  if (choice.kind !== "plan") return;
  assert.deepEqual(choice.plan.package, {
    registryType: "npm",
    identifier: "@notionhq/notion-mcp-server",
    version: "1.8.1",
  });
  assert.equal(
    choice.plan.install,
    "npx --yes --package='@notionhq/notion-mcp-server@1.8.1' -- true",
  );
  assert.equal(
    choice.plan.start,
    "npx --yes '@notionhq/notion-mcp-server@1.8.1'",
  );
  assert.deepEqual(choice.plan.env, {
    ...MCP_STDIO_FIXED_ENV,
    OPENAPI_MCP_HEADERS: MCP_STDIO_PLACEHOLDER,
  });
  assert.equal(choice.plan.installTimeoutMs, MCP_STDIO_INSTALL_TIMEOUT_MS);
  assert.equal(choice.plan.runTimeoutMs, MCP_STDIO_RUN_TIMEOUT_MS);
});

test("a PyPI package installs into a venv and runs its console script", () => {
  const choice = chooseStdioPackage([
    {
      registryType: "pypi",
      identifier: "mcp-server-fetch",
      version: "2025.4.7",
      runtimeHint: "uvx",
    },
  ]);
  assert.equal(choice.kind, "plan");
  if (choice.kind !== "plan") return;
  assert.equal(
    choice.plan.install,
    "python3 -m venv venv && ./venv/bin/pip install --quiet 'mcp-server-fetch==2025.4.7'",
  );
  assert.equal(
    choice.plan.start,
    `s='./venv/bin/mcp-server-fetch'; [ -x "$s" ] || { echo 'no console script named mcp-server-fetch' >&2; exit 127; }; exec "$s"`,
  );
});

test("a PyPI name is tried as given and in its PEP 503 form; no script is exit 127", () => {
  assert.equal(pep503Name("Weather_MCP.Server"), "weather-mcp-server");
  const choice = chooseStdioPackage([
    {
      registryType: "pypi",
      identifier: "Weather_MCP",
      version: "1.0",
      packageArguments: [{ type: "positional", value: "--stdio" }],
    },
  ]);
  assert.equal(choice.kind, "plan");
  if (choice.kind !== "plan") return;
  assert.equal(
    choice.plan.start,
    `s='./venv/bin/Weather_MCP'; [ -x "$s" ] || s='./venv/bin/weather-mcp'; [ -x "$s" ] || { echo 'no console script named Weather_MCP or weather-mcp' >&2; exit 127; }; exec "$s" '--stdio'`,
  );
});

test("runtime and package arguments follow the registry's order; required inputs get placeholders", () => {
  const choice = chooseStdioPackage([
    {
      registryType: "npm",
      identifier: "server",
      version: "2.0.0",
      runtimeArguments: [
        { type: "positional", value: "-y" },
        { type: "named", name: "--node-options", isRequired: true },
      ],
      packageArguments: [
        { type: "positional", value: "--transport" },
        { type: "positional", value: "stdio" },
        { type: "named", name: "--root", isRequired: true },
        { type: "named", name: "--optional" },
        { type: "positional", name: "token", isRequired: true, isSecret: true },
        { type: "named", name: "--key=", isRequired: true },
      ],
    },
  ]);
  assert.equal(choice.kind, "plan");
  if (choice.kind !== "plan") return;
  assert.equal(
    choice.plan.start,
    "npx --yes '--node-options' 'placeholder' 'server@2.0.0' '--transport' 'stdio' '--root' 'placeholder' 'placeholder' '--key=placeholder'",
  );
});

test("the first stdio package wins; one with another transport is passed over", () => {
  const choice = chooseStdioPackage([
    {
      registryType: "npm",
      identifier: "http-only",
      transport: { type: "streamable-http" },
    },
    { registryType: "oci", identifier: "ghcr.io/acme/server:1" },
    { registryType: "pypi", identifier: "acme-server" },
  ]);
  assert.equal(choice.kind, "plan");
  if (choice.kind !== "plan") return;
  assert.equal(choice.plan.package.identifier, "acme-server");
  assert.equal(choice.plan.package.version, null);
  assert.equal(
    choice.plan.install,
    "python3 -m venv venv && ./venv/bin/pip install --quiet 'acme-server'",
  );
});

test("container images, NuGet and bundles are unsupported, and so is nothing at all", () => {
  assert.deepEqual(
    chooseStdioPackage([
      { registryType: "oci", identifier: "ghcr.io/acme/server:1" },
      { registryType: "nuget", identifier: "Acme.Server" },
      { registryType: "mcpb", identifier: "https://example.com/a.mcpb" },
    ]),
    {
      kind: "unsupported",
      detail:
        "No runnable npm or PyPI package; registry types: oci, nuget, mcpb",
    },
  );
  assert.deepEqual(chooseStdioPackage([]), {
    kind: "unsupported",
    detail: "No stdio package to run",
  });
  assert.deepEqual(chooseStdioPackage("npm"), {
    kind: "unsupported",
    detail: "No stdio package to run",
  });
});

test("an identifier or version the package manager would not accept is not run", () => {
  for (const entry of [
    { registryType: "npm", identifier: "evil; rm -rf /", version: "1.0.0" },
    { registryType: "npm", identifier: "Server", version: "1.0.0" },
    { registryType: "npm", identifier: "server", version: "1.0.0 || true" },
    { registryType: "pypi", identifier: "-dash-first", version: "1" },
    { registryType: "pypi", identifier: "acme", version: "1;x" },
    { registryType: "npm", identifier: "a".repeat(215) },
  ]) {
    assert.equal(
      chooseStdioPackage([entry]).kind,
      "unsupported",
      JSON.stringify(entry),
    );
  }
});

test("every token reaching the shell is single-quoted", () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  const choice = chooseStdioPackage([
    {
      registryType: "npm",
      identifier: "server",
      packageArguments: [{ type: "positional", value: "$(whoami) `id` 'x'" }],
    },
  ]);
  assert.equal(choice.kind, "plan");
  if (choice.kind !== "plan") return;
  assert.equal(
    choice.plan.start,
    `npx --yes 'server' '$(whoami) \`id\` '\\''x'\\'''`,
  );
});

test("placeholders fill only required, well-formed variable names and never this process's environment", () => {
  process.env.STDIO_PACKAGE_TEST_SECRET = "real-secret";
  try {
    const env = placeholderEnvironment([
      { name: "API_KEY", isRequired: true, isSecret: true, value: "pasted" },
      { name: "OPTIONAL" },
      { name: "bad name", isRequired: true },
      { name: "STDIO_PACKAGE_TEST_SECRET", isRequired: true },
      { name: "PATH", isRequired: true },
      { name: "NO_COLOR", isRequired: true },
    ]);
    assert.deepEqual(env, {
      ...MCP_STDIO_FIXED_ENV,
      API_KEY: MCP_STDIO_PLACEHOLDER,
      STDIO_PACKAGE_TEST_SECRET: MCP_STDIO_PLACEHOLDER,
      PATH: MCP_STDIO_PLACEHOLDER,
    });
    assert.equal(JSON.stringify(env).includes("real-secret"), false);
    assert.equal(JSON.stringify(env).includes("pasted"), false);
  } finally {
    delete process.env.STDIO_PACKAGE_TEST_SECRET;
  }
});

test("argument tokens: named without a value only when required; malformed names dropped", () => {
  assert.deepEqual(
    argumentTokens([
      { type: "named", name: "--a", value: "1" },
      { type: "named", name: "--b" },
      { type: "named", name: "--c", isRequired: true },
      { type: "named", name: "not-a-flag", isRequired: true },
      { type: "named", name: "--d; rm", isRequired: true },
      { type: "positional", value: "p" },
      { type: "positional" },
      { type: "positional", isRequired: true },
    ]),
    ["--a", "1", "--c", "placeholder", "p", "placeholder"],
  );
  assert.deepEqual(argumentTokens(undefined), []);
});
