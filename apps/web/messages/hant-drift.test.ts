import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/i18n-hant.mjs", import.meta.url));

// zh-TW.json is generated from zh-CN.json + the glossary (OpenCC). This runs the
// real generator in --check mode, so a zh-CN edit that forgot to regenerate
// zh-TW (or a glossary change) fails here rather than shipping stale Traditional
// copy (design §8 / risk R4).
describe("zh-TW is generated, not hand-edited", () => {
  it("matches `pnpm --filter web i18n:hant` output", () => {
    expect(() =>
      execFileSync("node", [script, "--check"], { stdio: "pipe" }),
    ).not.toThrow();
  });
});
