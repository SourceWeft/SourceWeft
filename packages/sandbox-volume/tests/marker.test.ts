import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommandOutput } from "../src/protocol/marker";

test("embedded and nonterminal markers are not completion receipts", () => {
  for (const output of [
    'prefix __SWVOL__ 0 {"ok":true,"seq":1}\n',
    '__SWVOL__ 0 {"ok":true,"seq":1}\nmore output',
  ]) {
    const parsed = parseCommandOutput(output);
    assert.equal(parsed.markerFound, false);
    assert.equal(parsed.output, output);
  }
});
test("only the final complete marker is parsed without removing earlier user output", () => {
  const user = "__SWVOL__ 75 {}\nuser data";
  const parsed = parseCommandOutput(
    user + '\n__SWVOL__ 0 {"ok":true,"seq":2}\n',
  );
  assert.equal(parsed.output, user);
  assert.equal(parsed.flush?.seq, 2);
  assert.equal(parsed.instanceChanged, false);
});
