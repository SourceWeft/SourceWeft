"use strict";
// No upstream-binary fallback: the declared maintained native build is required.
try {
  module.exports = require("./native/bindings.node");
} catch (cause) {
  throw new Error(
    "Maintained AnyDoc native binding is unavailable; run pnpm --filter @sourceweft/anydoc native:build for this platform.",
    { cause },
  );
}
