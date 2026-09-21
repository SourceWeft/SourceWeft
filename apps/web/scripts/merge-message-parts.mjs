// Folds every `messages/parts/<ns>.<locale>.json` into `messages/<locale>.json`.
// Additive and idempotent: parts are the source of truth for their keys, so it
// can be re-run at any time (e.g. by parallel localization passes).
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const messagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "messages");
const partsDir = join(messagesDir, "parts");

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const current = target[key];
      target[key] =
        current && typeof current === "object" && !Array.isArray(current) ? current : {};
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

if (!existsSync(partsDir)) process.exit(0);
const byLocale = new Map();
for (const file of readdirSync(partsDir).sort()) {
  const match = /^(.+)\.(en|zh-CN)\.json$/.exec(file);
  if (!match) continue;
  const list = byLocale.get(match[2]) ?? [];
  list.push(file);
  byLocale.set(match[2], list);
}
for (const [locale, files] of byLocale) {
  const target = join(messagesDir, `${locale}.json`);
  const catalog = JSON.parse(readFileSync(target, "utf8"));
  for (const file of files) {
    deepMerge(catalog, JSON.parse(readFileSync(join(partsDir, file), "utf8")));
  }
  writeFileSync(target, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`merged ${files.length} part(s) into ${locale}.json`);
}
