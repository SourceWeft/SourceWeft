"use strict";
const fs = require("node:fs");
const path = require("node:path");
const runtime = process.env.SOURCEWEFT_HTML_RUNTIME;
const fonts = process.env.SOURCEWEFT_HTML_FONTS;
if (!runtime || !fonts || !fs.existsSync(fonts))
  throw new Error(
    "Provisioned SOURCEWEFT_HTML_RUNTIME and SOURCEWEFT_HTML_FONTS are required",
  );
const [source, output] = process.argv.slice(2);
if (!source || !output)
  throw new Error("Usage: node build-html.cjs draft.html report.html");
if (fs.existsSync(output))
  throw new Error(
    "Final HTML already exists; use a fresh generation directory",
  );
const { bundle } = require(path.join(runtime, "bundle.cjs"));
console.log(
  JSON.stringify(
    bundle({ source, output: path.resolve(output), fontDirectory: fonts }),
    null,
    2,
  ),
);
