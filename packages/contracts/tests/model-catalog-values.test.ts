import assert from "node:assert/strict";
import test from "node:test";
import {
  filterModelSupportedOptionValues,
  resolveModelCatalogValues,
} from "../src/agent-tools/model-catalog";

/**
 * These cover the resolver every client uses to narrow a configurable option to
 * what the selected model advertises. The important property is not that any
 * particular capability filters correctly — it is that the resolver reaches its
 * answer purely from the option's declared pointer, so no client ever has to
 * name an option, a tool, or a capability to do the narrowing.
 */

const CAPABILITIES = {
  imageGeneration: {
    supported: true,
    controls: {
      aspectRatio: { values: ["auto", "1:1", "16:9"] },
      quality: { values: [] as string[] },
    },
  },
};

const SOURCE = { key: "imageGeneration", path: "controls.aspectRatio.values" };

test("resolveModelCatalogValues walks the declared path", () => {
  assert.deepEqual(resolveModelCatalogValues(CAPABILITIES, SOURCE), [
    "auto",
    "1:1",
    "16:9",
  ]);
});

test("resolveModelCatalogValues returns null when nothing constrains the option", () => {
  // No declaration, no capabilities, an unknown annotation key, a path that
  // runs off the end of the object, and an annotation that advertises an empty
  // list all mean the same thing to a caller: this option is unconstrained.
  // They must not be reported as "no value is supported", which would leave the
  // user with an empty picker.
  assert.equal(resolveModelCatalogValues(CAPABILITIES, undefined), null);
  assert.equal(resolveModelCatalogValues(undefined, SOURCE), null);
  assert.equal(
    resolveModelCatalogValues(CAPABILITIES, { key: "speech", path: "voices" }),
    null,
  );
  assert.equal(
    resolveModelCatalogValues(CAPABILITIES, {
      key: "imageGeneration",
      path: "controls.aspectRatio.values.deeper",
    }),
    null,
  );
  assert.equal(
    resolveModelCatalogValues(CAPABILITIES, {
      key: "imageGeneration",
      path: "controls.quality.values",
    }),
    null,
  );
});

test("filterModelSupportedOptionValues keeps only advertised values", () => {
  const declared = [
    { value: "auto" },
    { value: "1:1" },
    { value: "21:9" },
    { value: "4:1" },
  ];

  assert.deepEqual(
    filterModelSupportedOptionValues(declared, SOURCE, CAPABILITIES),
    [{ value: "auto" }, { value: "1:1" }],
  );
});

test("filterModelSupportedOptionValues leaves unconstrained options alone", () => {
  const declared = [{ value: "auto" }, { value: "21:9" }];

  assert.deepEqual(
    filterModelSupportedOptionValues(declared, undefined, CAPABILITIES),
    declared,
  );
  assert.deepEqual(
    filterModelSupportedOptionValues(declared, SOURCE, undefined),
    declared,
  );
});

test("filterModelSupportedOptionValues keeps non-string values", () => {
  // Model-advertised lists are string enumerations, so a numeric or boolean
  // option could never appear in one. Filtering those out would silently empty
  // the picker rather than leaving it unconstrained.
  const declared = [{ value: 2 }, { value: true }, { value: "1:1" }];

  assert.deepEqual(
    filterModelSupportedOptionValues(declared, SOURCE, CAPABILITIES),
    [{ value: 2 }, { value: true }, { value: "1:1" }],
  );
});
