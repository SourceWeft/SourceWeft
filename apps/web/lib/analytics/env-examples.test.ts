import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const ANALYTICS_VARS = [
  "PUBLIC_GTM_ID",
  "PUBLIC_UMAMI_SCRIPT_URL",
  "PUBLIC_UMAMI_WEBSITE_ID",
];

function declaredVars(relativePath: string) {
  const text = readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
  return new Set(
    text
      .split("\n")
      .map((line) => /^([A-Z0-9_]+)=/.exec(line.trim())?.[1])
      .filter((name): name is string => Boolean(name)),
  );
}

test("docker and web env examples declare the same analytics variables", () => {
  for (const file of ["../../../../docker/.env.example", "../../.env.example"]) {
    const vars = declaredVars(file);
    for (const name of ANALYTICS_VARS) {
      assert.ok(vars.has(name), `${file} does not declare ${name}`);
    }
    assert.ok(!vars.has("NEXT_PUBLIC_GTM_ID"), `${file} declares NEXT_PUBLIC_GTM_ID`);
  }
});
