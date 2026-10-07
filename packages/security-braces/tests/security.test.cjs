"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const braces = require("..");
const upstream = require("./upstream-reference");
const security = require("../lib/security");
const utils = require("../lib/utils");
const implementations = ["compile", "expand", "stringify"];
const hostile = (error) =>
  error instanceof SyntaxError && /depth|cycle/.test(error.message);
const deepAst = (depth) => {
  const root = { type: "root", nodes: [] };
  let current = root;
  for (let i = 0; i < depth; i++) {
    const child = { type: "paren", nodes: [], parent: current };
    current.nodes.push(child);
    current = child;
  }
  current.nodes.push({ type: "text", value: "x", parent: current });
  return root;
};

test("fixed parser stack limit covers braces, parentheses and mixed structures", () => {
  for (const [open, close] of [
    ["{", "}"],
    ["(", ")"],
    ["{(", ")}"],
  ]) {
    const input = open.repeat(1000) + "a" + close.repeat(1000);
    for (const name of ["parse", ...implementations]) {
      assert.throws(
        () => braces[name](input, { maxDepth: Infinity, rangeLimit: false }),
        hostile,
      );
    }
  }
  for (const name of ["parse", ...implementations]) {
    assert.throws(() => braces[name]("{".repeat(2000)), hostile);
  }
});

test("escaped, quoted and bracketed delimiters do not count as structures", () => {
  for (const input of [
    "\\{".repeat(300),
    '"' + "{(".repeat(300) + '"',
    "[" + "{(".repeat(300) + "]",
  ]) {
    assert.deepEqual(braces(input), upstream(input));
  }
});

test("depth boundary is fixed and direct library AST paths cannot bypass it", () => {
  assert.equal(security.MAX_DEPTH, 100);
  for (const name of implementations) {
    const direct = require("../lib/" + name);
    assert.doesNotThrow(() => direct(deepAst(100)));
    assert.throws(() => direct(deepAst(101), { maxDepth: false }), hostile);
    assert.throws(() => braces[name](deepAst(1000)), hostile);
  }
});

test("nodes and parent cycles reject without treating ordinary backlinks as cycles", () => {
  for (const name of implementations) {
    const node = { type: "root", nodes: [] };
    node.nodes.push(node);
    assert.throws(() => braces[name](node), hostile);
    const parentCycle = deepAst(1);
    parentCycle.parent = parentCycle.nodes[0];
    assert.throws(() => braces[name](parentCycle), hostile);
    assert.doesNotThrow(() => braces[name](braces.parse("{a,b}")));
  }
});

test("flatten is iterative with a fixed array-depth/cycle guard and preserves shared values", () => {
  let deep = ["x"];
  for (let i = 0; i < 1000; i++) deep = [deep];
  assert.throws(() => utils.flatten(deep), hostile);
  const cycle = [];
  cycle.push(cycle);
  assert.throws(() => utils.flatten(cycle), hostile);
  const shared = ["a", undefined, "b"];
  assert.deepEqual(utils.flatten(shared, shared), ["a", "b", "a", "b"]);
});

test("deterministic safe differential corpus preserves all public method behavior", () => {
  const atoms = [
    "a",
    "b",
    "{x,y}",
    "{1..3}",
    "(a)",
    "[{}]",
    "\\{x,y\\}",
    "${a,b}",
    '"{a,b}"',
  ];
  const options = [
    {},
    { expand: true },
    { escapeInvalid: true },
    { keepEscaping: true },
    { noempty: true, nodupes: true },
  ];
  let seed = 7392;
  for (let i = 0; i < 500; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const input =
      atoms[seed % atoms.length] + "/" + atoms[(seed >>> 8) % atoms.length];
    for (const opts of options) {
      assert.deepEqual(braces(input, opts), upstream(input, opts));
      for (const name of implementations)
        assert.deepEqual(
          braces[name](input, opts),
          upstream[name](input, opts),
        );
    }
  }
});

test("non-array iterable nodes cannot bypass the direct AST guard", () => {
  const node = { type: "root" };
  node.nodes = {
    *[Symbol.iterator]() {
      yield node;
    },
  };
  for (const name of implementations) {
    assert.throws(() => require("../lib/" + name)(node), hostile);
  }
});

test("unchanged upstream source oracle, tests and MIT license match recorded provenance", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { createHash } = require("node:crypto");
  const origin = require("../UPSTREAM.json");
  assert.equal(origin.commit, "74b2db2938fad48a2ea54a9c8bf27a37a62c350d");
  for (const [file, expected] of Object.entries(origin.sha256)) {
    const source =
      file === "LICENSE"
        ? "../LICENSE"
        : file.startsWith("test/")
          ? "../upstream-test/" + file.slice(5)
          : "./upstream-reference/" + file;
    assert.equal(
      createHash("sha256")
        .update(fs.readFileSync(path.join(__dirname, source)))
        .digest("hex"),
      expected,
      file,
    );
  }
});

test("hostile structures reject in a bounded low-stack subprocess", () => {
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const script = `
    const assert = require('node:assert/strict');
    const braces = require(${JSON.stringify(path.resolve(__dirname, ".."))});
    const utils = require(${JSON.stringify(path.resolve(__dirname, "../lib/utils"))});
    for (const delimiter of ['{', '(']) {
      for (const method of ['parse', 'compile', 'expand', 'stringify']) {
        assert.throws(() => braces[method](delimiter.repeat(5000)), SyntaxError);
      }
    }
    const cycle = { type: 'root', nodes: [] }; cycle.nodes.push(cycle);
    for (const method of ['compile', 'expand', 'stringify']) {
      assert.throws(() => braces[method](cycle), SyntaxError);
    }
    const array = []; array.push(array);
    assert.throws(() => utils.flatten(array), SyntaxError);
    process.stdout.write('guarded');
  `;
  const result = spawnSync(
    process.execPath,
    ["--stack-size=256", "-e", script],
    { timeout: 5000, encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "guarded");
});

test("function-valued AST nodes and parent links cannot bypass cycle validation", () => {
  const callable = () => {};
  callable.nodes = [callable];
  const parent = () => {};
  parent.parent = parent;
  for (const name of implementations) {
    const direct = require("../lib/" + name);
    assert.throws(() => direct(callable), hostile);
    assert.throws(() => direct({ type: "root", nodes: [callable] }), hostile);
    assert.throws(() => direct({ type: "paren", nodes: [], parent }), hostile);
  }
});
