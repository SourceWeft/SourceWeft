import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { comparableConfig, trimStrings } from "./json-compare";

describe("trimStrings", () => {
  test("trims top-level and nested string values", () => {
    assert.deepEqual(
      trimStrings({ a: "  x ", nested: { b: "\ty\n", deeper: { c: " z" } } }),
      { a: "x", nested: { b: "y", deeper: { c: "z" } } },
    );
  });

  test("trims strings inside arrays, including arrays of objects", () => {
    assert.deepEqual(trimStrings({ list: [" a ", { b: " c " }, [" d "]] }), {
      list: ["a", { b: "c" }, ["d"]],
    });
  });

  test("leaves non-string values untouched", () => {
    assert.deepEqual(
      trimStrings({ n: 1, b: false, z: null, u: undefined, o: {} }),
      { n: 1, b: false, z: null, u: undefined, o: {} },
    );
    assert.equal(trimStrings(42), 42);
    assert.equal(trimStrings(null), null);
    assert.equal(trimStrings("  s "), "s");
  });

  test("does not mutate its input", () => {
    const input = { a: " x ", list: [" y "] };
    trimStrings(input);
    assert.deepEqual(input, { a: " x ", list: [" y "] });
  });
});

describe("comparableConfig", () => {
  test("values that differ only by surrounding whitespace compare equal", () => {
    assert.equal(
      comparableConfig({ feedUrl: "https://example.com/feed.xml" }),
      comparableConfig({ feedUrl: "  https://example.com/feed.xml\n" }),
    );
  });

  test("is independent of key order, including nested objects", () => {
    assert.equal(
      comparableConfig({ a: 1, nested: { x: " 1", y: [1, 2] }, b: "two" }),
      comparableConfig({ b: "two ", nested: { y: [1, 2], x: "1" }, a: 1 }),
    );
  });

  test("array order is significant", () => {
    assert.notEqual(
      comparableConfig({ list: ["a", "b"] }),
      comparableConfig({ list: ["b", "a"] }),
    );
  });

  test("different values and non-string values still differ", () => {
    assert.notEqual(
      comparableConfig({ feedUrl: "https://example.com/a" }),
      comparableConfig({ feedUrl: "https://example.com/b" }),
    );
    assert.notEqual(comparableConfig({ n: 1 }), comparableConfig({ n: "1" }));
    assert.notEqual(
      comparableConfig({ flag: true }),
      comparableConfig({ flag: "true" }),
    );
  });

  test("inner whitespace is not collapsed", () => {
    assert.notEqual(
      comparableConfig({ title: "a b" }),
      comparableConfig({ title: "a  b" }),
    );
  });
});
