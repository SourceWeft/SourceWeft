import assert from "node:assert/strict";
import { test } from "vitest";
import { identifierForSearch } from "./read-repository";

test("search identifiers ignore the generic GitHub registry namespace", () => {
  assert.equal(
    identifierForSearch("io.github.wulfkaal/corpus"),
    "wulfkaal/corpus",
  );
  assert.equal(
    identifierForSearch("io.github.github/github-mcp-server"),
    "github/github-mcp-server",
  );
  assert.equal(identifierForSearch("com.github.acme/server"), "acme/server");
});
