"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const versions = {
  parse5: "7.3.0",
  postcss: "8.5.26",
  "postcss-value-parser": "4.2.0",
  playwright: "1.59.1",
};
module.exports = function load(name) {
  const root = process.env.NODE_PATH?.split(path.delimiter)[0];
  if (!root)
    throw new Error(
      "NODE_PATH must identify the provisioned HTML runtime dependencies",
    );
  if (!versions[name])
    throw new Error("Unknown HTML runtime dependency: " + name);
  const directory = path.join(root, name);
  const metadata = JSON.parse(
    fs.readFileSync(path.join(directory, "package.json"), "utf8"),
  );
  if (metadata.version !== versions[name])
    throw new Error(
      `HTML runtime requires ${name}@${versions[name]}; found ${metadata.version}`,
    );
  return require(directory);
};
