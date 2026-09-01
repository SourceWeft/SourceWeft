import assert from "node:assert/strict";
import test from "node:test";
import {
  VIDEO_LAYOUT_PRIMITIVES_TSX,
  VIDEO_LAYOUT_PRIMITIVE_EXPORT_NAMES,
} from "../src/pipeline/layout-source";
import { normalizeSceneProjectCode } from "../src/pipeline/scene-source";

function exportedPrimitiveNames() {
  return new Set(
    [
      ...VIDEO_LAYOUT_PRIMITIVES_TSX.matchAll(
        /^export\s+(?:function|const)\s+([A-Za-z_$][\w$]*)/gmu,
      ),
    ].map((match) => match[1]!),
  );
}

function layoutImports(code: string) {
  const match = code.match(
    /import\s*\{([^}]*)\}\s*from\s*"\.\/layout-primitives"/u,
  );
  assert.ok(match, `missing layout-primitives import in:\n${code}`);
  return new Set(
    match[1]!
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

test("layout primitive names match the sandbox source", () => {
  assert.deepEqual(
    [...VIDEO_LAYOUT_PRIMITIVE_EXPORT_NAMES].sort(),
    [...exportedPrimitiveNames()].sort(),
  );
});

test("normalized authored scenes import every trusted layout primitive", () => {
  const normalized = normalizeSceneProjectCode(
    "export default function VideoScene() { return null; }",
  );
  assert.deepEqual(
    [...layoutImports(normalized)].sort(),
    [...exportedPrimitiveNames()].sort(),
  );
});
