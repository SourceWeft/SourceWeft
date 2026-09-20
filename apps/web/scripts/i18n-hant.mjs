// Generate the Traditional Chinese (zh-TW) catalog from the Simplified (zh-CN)
// source with OpenCC (Taiwan standard + idioms), then apply a small glossary of
// product-term overrides OpenCC does not cover. zh-TW.json is a build artifact:
// edit zh-CN.json (and the glossary), never zh-TW.json by hand. `--check`
// re-generates and fails if the committed file drifted, so CI catches a zh-CN
// change that forgot to regenerate (design §8, D7).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import * as OpenCC from "opencc-js";

const here = dirname(fileURLToPath(import.meta.url));
const messagesDir = join(here, "..", "messages");
const convert = OpenCC.Converter({ from: "cn", to: "twp" });

let glossary = {};
try {
  glossary = JSON.parse(
    readFileSync(join(messagesDir, "glossary", "zh-TW.json"), "utf8"),
  );
} catch {
  // No glossary yet: OpenCC output stands on its own.
}
// Longer source terms first so a specific phrase wins over a substring of it.
const glossaryEntries = Object.entries(glossary).sort(
  (a, b) => b[0].length - a[0].length,
);

function applyGlossary(text) {
  let out = text;
  for (const [from, to] of glossaryEntries) {
    out = out.split(from).join(to);
  }
  return out;
}

function translate(value) {
  if (typeof value === "string") {
    return applyGlossary(convert(value));
  }
  if (Array.isArray(value)) {
    return value.map(translate);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = translate(child);
    }
    return out;
  }
  return value;
}

// Every zh-CN catalog whose zh-TW is generated from it with the shared glossary.
// The web UI catalog and the (licensed) billing display catalog both flow
// through the one engine, so Traditional stays consistent everywhere.
const TARGETS = [
  messagesDir,
  join(here, "..", "..", "..", "enterprise", "billing", "messages"),
];

const check = process.argv.includes("--check");
let stale = false;

for (const dir of TARGETS) {
  const source = JSON.parse(readFileSync(join(dir, "zh-CN.json"), "utf8"));
  const output = `${JSON.stringify(translate(source), null, 2)}\n`;
  const target = join(dir, "zh-TW.json");

  if (check) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = "";
    }
    if (current !== output) {
      console.error(`Out of date: ${target}`);
      stale = true;
    }
  } else {
    writeFileSync(target, output);
    console.log(`Generated ${target} from zh-CN.json.`);
  }
}

if (check) {
  if (stale) {
    console.error("Run `pnpm --filter web i18n:hant` and commit the result.");
    process.exit(1);
  }
  console.log("All zh-TW catalogs are up to date.");
}
