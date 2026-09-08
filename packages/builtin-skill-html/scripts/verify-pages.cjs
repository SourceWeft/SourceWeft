const path = require("node:path"),
  fs = require("node:fs"),
  { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  out = path.resolve(process.argv[2] || "output/html-pages");
const results = [];
for (const name of ["report", "landing", "visualization"]) {
  const dir = path.join(out, name);
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(root, ".tests/fixtures", name + ".html"),
    file = path.join(dir, "index.html");
  const interactions = path.join(root, ".tests/fixtures", name + "-checks.cjs");
  for (const [script, args] of [
    ["build.cjs", [source, file]],
    [
      "qa.cjs",
      [
        file,
        path.join(dir, "qa"),
        ...(fs.existsSync(interactions) ? [interactions] : []),
      ],
    ],
  ]) {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, script), ...args],
      {
        env: process.env,
        encoding: "utf8",
        timeout: 300000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    fs.writeFileSync(
      path.join(dir, script + ".log"),
      (result.stdout || "") + (result.stderr || ""),
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      results.push({ name, passed: false, stage: script });
      break;
    }
    if (script === "qa.cjs") results.push({ name, passed: true });
  }
  console.log(JSON.stringify(results.at(-1)));
}
fs.writeFileSync(
  path.join(out, "summary.json"),
  JSON.stringify(results, null, 2),
);
if (results.some((r) => !r.passed)) process.exitCode = 1;
