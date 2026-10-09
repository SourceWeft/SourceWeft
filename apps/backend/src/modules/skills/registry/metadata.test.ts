import assert from "node:assert/strict";
import { test } from "vitest";
import { isAgentSkillName, isSafeSkillDirName } from "@sourceweft/skill-format";
import {
  readRegistryMetadata,
  registryInstallName,
  hasRegistryFrontmatter,
} from "./metadata";

test("derives visible title and summary while ignoring code, comments and images", () => {
  const source =
    "<!-- hidden -->\n```md\n# Fake\nFalse text\n```\n# **A 股** Watcher\n\n> Read **market** data with `quotes`.\n\n![badge](x)";
  const result = readRegistryMetadata(source, "watcher");
  assert.deepEqual(result, {
    derived: true,
    metadata: {
      name: "A 股 Watcher",
      description: "Read market data with quotes.",
    },
  });
});
test("plain text gets a source-directory name, empty and code-only content derives no usable fields", () => {
  assert.deepEqual(readRegistryMetadata("Read prices.", "watcher").metadata, {
    name: "watcher",
    description: "Read prices.",
  });
  for (const source of [
    "",
    "```md\n# Fake\ntext\n```",
    "<!-- only comment -->",
    "![badge](x)",
  ])
    assert.deepEqual(readRegistryMetadata(source, "fallback").metadata, {});
});
test("explicit metadata stays authoritative, including empty and incomplete blocks", () => {
  for (const source of ["---\nname: x\n---\n# Heading\nSummary"]) {
    const result = readRegistryMetadata(source, "fallback");
    assert.equal(result.derived, false);
    assert.equal(result.metadata.description, undefined);
  }
  assert.throws(() =>
    readRegistryMetadata("---\n---\n# Heading\nSummary", "fallback"),
  );
  assert.throws(() =>
    readRegistryMetadata(
      "---\nname: [broken\n---\n# Heading\nSummary",
      "fallback",
    ),
  );
});
test("leading comments before valid frontmatter are a parse view, not replacement metadata", () => {
  const source =
    "\uFEFF<!-- generated -->\r\n---\r\nname: x\r\ndescription: real\r\n---\r\nBody";
  assert.equal(hasRegistryFrontmatter(source), true);
  assert.deepEqual(readRegistryMetadata(source, "fallback"), {
    derived: false,
    metadata: { name: "x", description: "real" },
  });
});
test("safe names stay stable; human titles, reserved names and collisions get safe deterministic names", () => {
  assert.equal(registryInstallName("figma-use", "dir"), "figma-use");
  for (const title of [
    "A 股 Watcher",
    "Bad Name!",
    "con",
    "x".repeat(100),
    "../../shell",
  ]) {
    const name = registryInstallName(title, "fallback");
    assert.ok(isAgentSkillName(name));
    assert.ok(isSafeSkillDirName(name));
    assert.equal(name, registryInstallName(title, "other-directory"));
  }
  assert.notEqual(
    registryInstallName("Bad Name!", "dir"),
    registryInstallName("Bad_Name", "dir"),
  );
});

test("YAML diagnostics retain original source lines after leading comments", () => {
  const bad = "---\nname: [broken\n---\nBody";
  let baseline: unknown;
  try {
    readRegistryMetadata(bad, "fallback");
  } catch (error) {
    baseline = error;
  }
  assert.throws(
    () => readRegistryMetadata("<!-- first\nsecond -->\n" + bad, "fallback"),
    (error: unknown) => {
      assert.equal(
        (error as { line: number }).line,
        (baseline as { line: number }).line + 2,
      );
      return true;
    },
  );
});
