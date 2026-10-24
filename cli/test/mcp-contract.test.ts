import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MARKET_MCP_INSPECT_LIMITS } from "../src/mcp/contract";

/**
 * The CLI keeps its own copy of the inspect limits (see src/mcp/contract.ts:
 * the contract package is not built where the CLI is tested). This reads the
 * contract's source, which the repository checkout always has, and fails
 * when the numbers differ.
 */
const CONTRACT_SOURCE = fileURLToPath(
  new URL("../../packages/market-contracts/src/index.ts", import.meta.url),
);

function contractLimits(): Record<string, number> {
  const source = readFileSync(CONTRACT_SOURCE, "utf8");
  const block = /export const MARKET_MCP_INSPECT_LIMITS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(
    source,
  );
  assert.ok(block, "MARKET_MCP_INSPECT_LIMITS not found in the contract source");
  const limits: Record<string, number> = {};
  for (const line of block[1]!.split("\n")) {
    const entry = /^\s*(\w+):\s*([\d_ *]+),/.exec(line);
    if (!entry) continue;
    // Plain arithmetic of numbers only, e.g. `16 * 1024` or `2_000`.
    limits[entry[1]!] = entry[2]!
      .replaceAll("_", "")
      .split("*")
      .reduce((product, factor) => product * Number(factor.trim()), 1);
  }
  return limits;
}

describe("inspect limits", () => {
  it("match the platform contract", () => {
    assert.deepEqual(contractLimits(), { ...MARKET_MCP_INSPECT_LIMITS });
  });
});
