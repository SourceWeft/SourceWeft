"use strict";

// Fixed library invariant; caller options cannot remove this protection.
const MAX_DEPTH = 100;
const reject = () => {
  throw new SyntaxError(
    "Brace structure exceeds the safe depth or contains a cycle",
  );
};

exports.MAX_DEPTH = MAX_DEPTH;
exports.assertDepth = (depth) => {
  if (depth > MAX_DEPTH) reject();
};

// Parent/prev pointers in a valid AST point backwards. Only nodes edges
// participate in tree traversal; parent chains are validated independently.
exports.assertAst = (ast) => {
  const active = new Set();
  const frames = [{ node: ast, depth: 0 }];
  while (frames.length) {
    const { node, depth, exit } = frames.pop();
    if (typeof node === "function") reject();
    if (!node || typeof node !== "object") continue;
    if (exit) {
      active.delete(node);
      continue;
    }
    if (active.has(node)) reject();
    if (node.nodes) {
      if (!Array.isArray(node.nodes)) reject();
      exports.assertDepth(depth);
    }
    const parents = new Set();
    let parent = node;
    while (parent && typeof parent === "object") {
      if (parents.has(parent) || parents.size > MAX_DEPTH + 1) reject();
      parents.add(parent);
      parent = parent.parent;
      if (typeof parent === "function") reject();
    }
    active.add(node);
    frames.push({ node, exit: true });
    if (Array.isArray(node.nodes)) {
      for (let i = node.nodes.length - 1; i >= 0; i--) {
        frames.push({ node: node.nodes[i], depth: depth + 1 });
      }
    }
  }
};
