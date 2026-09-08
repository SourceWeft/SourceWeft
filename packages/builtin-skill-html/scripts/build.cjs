"use strict";
const path = require("node:path");
const runtime = process.env.SOURCEWEFT_HTML_RUNTIME;
if (!runtime)
  throw new Error(
    "SOURCEWEFT_HTML_RUNTIME is required; provision the pinned runtime",
  );
const [source, output] = process.argv.slice(2);
if (!source || !output)
  throw new Error("Usage: node build.cjs source.html index.html");
const { bundle } = require(path.join(runtime, "bundle.cjs"));
console.log(
  JSON.stringify(
    bundle({
      source,
      output: path.resolve(output),
      fontDirectory: process.env.SOURCEWEFT_HTML_FONTS,
    }),
    null,
    2,
  ),
);
