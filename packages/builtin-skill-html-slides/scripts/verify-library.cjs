"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  catalog = JSON.parse(
    fs.readFileSync(path.join(root, "runtime/catalog.json"), "utf8"),
  );
const runtime = process.env.SOURCEWEFT_HTML_RUNTIME;
if (!runtime) throw new Error("SOURCEWEFT_HTML_RUNTIME is required");
const H = require(path.join(runtime, "bundle.cjs"));
const out = path.resolve(process.argv[2] || "output/html-library");
fs.mkdirSync(out, { recursive: true });
const wrap = (sections) =>
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>' +
  sections.join("\n") +
  "</body></html>";
const samples = {};
samples.themes = catalog.themes.map(
  (theme, i) =>
    `<section data-slide-id="theme-${i}" data-theme="${theme}"><p class="kicker">${theme}</p><h1 class="h1">知识驱动决策</h1><p class="lede">Knowledge becomes useful when it changes what we do.</p><div class="grid g2"><div class="card"><h3>清晰的结构</h3><p>让证据、推理与行动彼此连接。</p></div><div class="card"><h3>Useful evidence</h3><p>Readable, offline, and ready to share.</p></div></div></section>`,
);
samples.layouts = catalog.layouts.map((layout, i) => {
  const doc = H.parse(
    fs.readFileSync(
      path.join(root, "runtime/layouts", layout + ".html"),
      "utf8",
    ),
  );
  let section;
  H.walk(doc, (n) => {
    if (n.tagName === "section" && !section) section = n;
  });
  H.setAttr(section, "data-slide-id", "layout-" + i);
  H.setAttr(section, "data-layout", layout);
  H.setAttr(section, "data-title", layout);
  let styles = "";
  H.walk(doc, (n) => {
    if (n.tagName === "style") {
      const css = H.postcss.parse(
        (n.childNodes || []).map((c) => c.value || "").join(""),
      );
      css.walkRules((rule) => {
        if (
          rule.parent?.type === "atrule" &&
          /keyframes$/.test(rule.parent.name)
        )
          return;
        rule.selector = rule.selector
          .split(",")
          .map((s) => `[data-layout="${layout}"] ${s.trim()}`)
          .join(",");
      });
      styles += "<style>" + css.toString() + "</style>";
    }
  });
  return styles + H.serializeOuter(section);
});
samples.animations = catalog.animations.map((animation, i) => {
  let content = `<div class="card ${animation === "counter-up" ? "counter" : ""}" data-to="2400" data-anim="${animation}" ${animation === "parallax-tilt" ? "data-qa-hover" : ""} style="width:${animation === "parallax-tilt" ? "70%" : "90%"};height:300px;display:flex;align-items:center;justify-content:center;font-size:48px">${animation === "counter-up" ? "2400" : "Ideas in motion"}</div>`;
  if (animation === "path-draw")
    content =
      '<svg class="anim-path-draw" data-anim="path-draw" viewBox="0 0 900 300" style="width:90%;height:300px"><path d="M30 250 C160 30 310 290 470 80 S740 200 860 40" fill="none" stroke="var(--accent)" stroke-width="8"/></svg>';
  if (animation === "morph-shape")
    content =
      '<svg data-anim="morph-shape" viewBox="0 0 360 240" style="height:300px;width:90%"><path d="M60,120 Q120,20 180,120 T300,120" stroke="var(--accent)" stroke-width="7" fill="none"/></svg>';
  if (animation === "stagger-list")
    content =
      '<div class="anim-stagger-list" data-anim="stagger-list"><p class="card">First, make the question clear.</p><p class="card">Then, connect the evidence.</p><p class="card">Finally, decide what comes next.</p></div>';
  if (animation === "marquee-scroll")
    content =
      '<div class="card" style="width:90%;height:300px;overflow:hidden;display:flex;align-items:center"><div data-anim="marquee-scroll" data-text-role="decoration" style="font-size:48px">Ideas in motion · Ideas in motion · Ideas in motion · Ideas in motion</div></div>';
  return `<section data-slide-id="animation-${i}" data-title="${animation}"><p class="kicker">${animation}</p><h2 class="h2">动画与信息节奏</h2>${content}</section>`;
});
samples.effects = catalog.effects.map(
  (effect, i) =>
    `<section data-slide-id="effect-${i}" data-title="${effect}" data-theme="catppuccin-mocha" data-capture-ms="${effect === "typewriter-multi" ? 3500 : 2800}"><p class="kicker">${effect}</p><h2 class="h2">效果即表达</h2><div data-fx="${effect}" data-text-role="decoration" style="height:440px;width:100%;position:relative;border-radius:16px;overflow:hidden;background:var(--surface-2)" data-fx-text-value="知识 EXPLODE"></div></section>`,
);
const results = [];
for (const [name, sections] of Object.entries(samples)) {
  if (process.argv[3] && process.argv[3] !== name) continue;
  const dir = path.join(out, name);
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, "source.html"),
    file = path.join(dir, "index.html");
  fs.writeFileSync(source, wrap(sections));
  for (const [script, args] of [
    ["build.cjs", [source, file]],
    ["qa.cjs", [file, path.join(dir, "qa")]],
  ]) {
    const run = spawnSync(
      process.execPath,
      [path.join(__dirname, script), ...args],
      {
        env: process.env,
        encoding: "utf8",
        timeout: 600_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    fs.writeFileSync(
      path.join(dir, script + ".log"),
      (run.stdout || "") + (run.stderr || ""),
    );
    if (run.error) throw run.error;
    if (run.status !== 0) {
      results.push({
        name,
        count: sections.length,
        passed: false,
        stage: script,
      });
      break;
    }
    if (script === "qa.cjs")
      results.push({ name, count: sections.length, passed: true });
  }
  console.log(JSON.stringify(results.at(-1)));
}
fs.writeFileSync(
  path.join(out, "summary.json"),
  JSON.stringify(results, null, 2),
);
if (results.some((r) => !r.passed)) process.exitCode = 1;
