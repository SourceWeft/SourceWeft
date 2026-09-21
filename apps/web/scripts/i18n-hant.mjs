// Generate the Traditional Chinese (zh-TW) catalog from the Simplified (zh-CN)
// source with `toTaiwanTraditional` from @sourceweft/i18n/hant: OpenCC (Taiwan
// standard + idioms) plus the shared glossary in packages/i18n/glossary, which
// generated content (skill overviews) goes through too. zh-TW.json is a build
// artifact: edit zh-CN.json (and the glossary), never zh-TW.json by hand. `--check`
// re-generates and fails if the committed file drifted, so CI catches a zh-CN
// change that forgot to regenerate (design §8, D7).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { toTaiwanTraditional } from "@sourceweft/i18n/hant";

const here = dirname(fileURLToPath(import.meta.url));
const messagesDir = join(here, "..", "messages");

function translate(value) {
  if (typeof value === "string") {
    return toTaiwanTraditional(value);
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
