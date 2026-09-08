"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const runtime = process.env.SOURCEWEFT_HTML_RUNTIME;
if (!runtime)
  throw new Error(
    "SOURCEWEFT_HTML_RUNTIME is required; use the provisioned HTML runtime",
  );
const H = require(path.join(runtime, "bundle.cjs"));
const postcss = H.postcss;
const home = path.resolve(__dirname, ".."),
  assets = path.join(home, "runtime");
const catalog = JSON.parse(
  fs.readFileSync(path.join(assets, "catalog.json"), "utf8"),
);
const argv = process.argv.slice(2),
  options = Object.fromEntries(
    argv
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [k, ...v] = a.slice(2).split("=");
        return [k, v.join("=") || true];
      }),
  );
const positionals = argv.filter((a) => !a.startsWith("--"));
const read = (file) =>
  new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
let source = options.layout
  ? path.join(assets, "layouts", String(options.layout) + ".html")
  : positionals[0];
const output = options.layout ? positionals[0] : positionals[1];
if (!source || !output)
  throw new Error(
    "Usage: build.cjs source.html index.html [--theme=minimal-white] [--ratio=16:9] OR build.cjs draft.html --layout=two-column --starter",
  );
if (options.layout && !catalog.layouts.includes(options.layout))
  throw new Error("Unknown layout");
const original = H.parse(read(source));
let sourceHead, sourceBody, sourceRoot;
H.walk(original, (n) => {
  if (n.tagName === "head") sourceHead = n;
  if (n.tagName === "body") sourceBody = n;
  if (n.tagName === "html") sourceRoot = n;
});
let container;
H.walk(sourceBody, (n) => {
  if (H.attr(n, "class")?.split(/\s+/).includes("slides")) container = n;
});
if (!container)
  H.walk(sourceBody, (n) => {
    if (H.attr(n, "class")?.split(/\s+/).includes("deck")) container = n;
  });
container ||= sourceBody;
const sections = (container.childNodes || []).filter(
  (n) => n.tagName === "section",
);
if (sections.length < 1 || sections.length > 40)
  throw new Error("Presentations must contain 1–40 flat section elements");
const ids = new Set(),
  effects = new Set(),
  themes = new Set();
let charts = false,
  highlight = false;
const defaultTheme = String(
  options.theme || H.attr(sourceRoot, "data-sw-theme") || "minimal-white",
);
if (!catalog.themes.includes(defaultTheme))
  throw new Error("Unknown theme: " + defaultTheme);
for (const [index, section] of sections.entries()) {
  const id =
    H.attr(section, "data-slide-id") ||
    "slide-" +
      crypto
        .createHash("sha256")
        .update(H.serializeOuter(section) + index)
        .digest("hex")
        .slice(0, 12);
  if (ids.has(id)) throw new Error("Duplicate slide ID: " + id);
  ids.add(id);
  H.setAttr(section, "data-slide-id", id);
  H.setAttr(
    section,
    "class",
    [
      ...(H.attr(section, "class") || "")
        .split(/\s+/)
        .filter(
          (c) =>
            c &&
            !["is-active", "is-prev", "present", "past", "future"].includes(c),
        ),
      "slide",
    ].join(" "),
  );
  const theme = H.attr(section, "data-theme") || defaultTheme;
  if (!catalog.themes.includes(theme)) throw new Error("Unknown page theme");
  themes.add(theme);
  H.setAttr(section, "data-theme", theme);
  if (options.layout) H.setAttr(section, "data-layout", options.layout);
  H.walk(section, (n) => {
    if (n.tagName === "canvas" && H.attr(n, "data-chart") !== undefined)
      charts = true;
    if (n.tagName === "code" && H.attr(n, "class")?.includes("language-"))
      highlight = true;
    if (n !== section && n.tagName === "section")
      throw new Error("Nested slides are not supported");
    const fx = H.attr(n, "data-fx");
    if (fx) {
      if (!catalog.effects.includes(fx)) throw new Error("Unknown FX: " + fx);
      effects.add(fx);
    }
    const animation = H.attr(n, "data-anim");
    if (
      fx &&
      (animation === "counter-up" ||
        H.attr(n, "class")?.split(/\s+/).includes("counter"))
    )
      throw new Error(
        "Use separate elements for FX and numeric entry counters",
      );
    if (
      (animation === "counter-up" ||
        H.attr(n, "class")?.split(/\s+/).includes("counter")) &&
      !H.attr(n, "data-to") &&
      !H.attr(n, "data-target")
    ) {
      let text = "";
      H.walk(n, (c) => {
        if (c.nodeName === "#text") text += c.value;
      });
      const value = Number(text.replace(/[^\d.-]/g, ""));
      if (!Number.isFinite(value))
        throw new Error("Counter requires a finite target");
      H.setAttr(n, "data-target", value);
    }
    if (animation && !catalog.animations.includes(animation))
      throw new Error("Unknown animation: " + animation);
  });
}
const ratio = String(
  options.ratio || H.attr(sourceRoot, "data-sw-ratio") || "16:9",
);
if (!["16:9", "4:3"].includes(ratio))
  throw new Error("Supported ratios are 16:9 and 4:3");
const doc = H.parse(
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>',
);
let head, body, html;
H.walk(doc, (n) => {
  if (n.tagName === "head") head = n;
  if (n.tagName === "body") body = n;
  if (n.tagName === "html") html = n;
});
H.setAttr(html, "lang", H.attr(sourceRoot, "lang") || "zh-CN");
H.setAttr(html, "data-sw-theme", defaultTheme);
H.setAttr(html, "data-sw-ratio", ratio);
for (const node of [
  ...(sourceHead.childNodes || []),
  ...(sourceBody.childNodes || []).filter((n) => n.tagName === "style"),
]) {
  if (
    !node.tagName ||
    ["meta"].includes(node.tagName) ||
    H.attr(node, "data-sw-runtime") ||
    H.attr(node, "id")?.startsWith("sourceweft-")
  )
    continue;
  if (options.layout && node.tagName !== "style" && node.tagName !== "title")
    continue;
  H.append(head, node);
}
const wrapper = H.element("div", { class: "reveal" }),
  slides = H.element("div", { class: "slides" });
H.append(wrapper, slides);
H.append(body, wrapper);
for (const section of sections) H.append(slides, section);
if (options.starter) {
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, H.serialize(doc));
  console.log(
    JSON.stringify({ draft: path.resolve(output), slideIds: [...ids] }),
  );
  process.exit(0);
}
const fontDirectory = process.env.SOURCEWEFT_HTML_FONTS;
if (!fontDirectory) throw new Error("SOURCEWEFT_HTML_FONTS is required");
const fonts = JSON.parse(read(path.join(fontDirectory, "catalog.json"))),
  families = new Set(fonts.files.map((f) => f.family));
function normalizeFonts(css) {
  const root = postcss.parse(css);
  root.walkDecls((d) => {
    if (d.prop.startsWith("--font-") && !d.value.includes("var(")) {
      const chosen = d.value
        .split(",")
        .map((x) => x.trim().replace(/^['"]|['"]$/g, ""))
        .filter((x) => families.has(x));
      for (const f of fonts.fallbackFamilies)
        if (!chosen.includes(f)) chosen.push(f);
      d.value = chosen.map((x) => JSON.stringify(x)).join(",");
    }
  });
  return root.toString();
}
const builtStyles = [
  ...(highlight ? [read(path.join(assets, "highlight.css"))] : []),
  read(path.join(assets, "reveal.css")),
  normalizeFonts(read(path.join(assets, "base.css"))),
  read(path.join(assets, "animations.css")),
];
for (const name of themes) {
  const sheet = postcss.parse(
    normalizeFonts(read(path.join(assets, "themes", name + ".css"))),
  );
  sheet.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name))
      return;
    rule.selector = rule.selector
      .split(",")
      .map((s) =>
        /^(?:body|html|:root)(?=$|[\s:.#[])/.test(s.trim())
          ? s.trim().replace(/^(?:body|html|:root)/, `[data-theme="${name}"]`)
          : `[data-theme="${name}"] ${s.trim()}`,
      )
      .join(",");
  });
  builtStyles.push(sheet.toString());
}
builtStyles.push(
  `.reveal{color:var(--text-1);font-family:var(--font-sans)}.reveal .slides>section{box-sizing:border-box;height:100%;padding:40px 56px;flex-direction:column;justify-content:center;text-align:left;background:var(--bg);color:var(--text-1);font-size:24px;line-height:1.45;font-family:var(--font-sans)}.reveal p{margin:0 0 16px}.reveal ul,.reveal ol{margin-top:0}.reveal .slides>section:not(.present) [data-anim],.fragment:not(.visible)[data-anim]{animation:none!important}.sw-fullscreen{position:fixed;right:16px;top:12px;z-index:100;font:14px var(--font-sans);padding:6px 12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-2)}.sw-capture *{transition:none!important;animation-play-state:paused!important;animation-delay:var(--sw-capture-delay)!important}.sw-capture .sw-fullscreen,.sw-capture .controls,.sw-capture .progress,.sw-capture .slide-number{display:none!important}`,
);
const style = H.element(
  "style",
  { "data-sw-runtime": "styles" },
  builtStyles.join("\n"),
);
style.parentNode = head;
head.childNodes.unshift(style);
const pages = sections.map((section, index) => {
  let heading;
  H.walk(section, (n) => {
    if (!heading && ["h1", "h2", "h3"].includes(n.tagName)) heading = n;
  });
  let title = "";
  if (heading)
    H.walk(heading, (n) => {
      if (n.nodeName === "#text") title += n.value;
    });
  return {
    id: H.attr(section, "data-slide-id"),
    title: (
      H.attr(section, "data-title") ||
      title.trim() ||
      `Page ${index + 1}`
    ).slice(0, 300),
    thumbnail: `slide-${String(index + 1).padStart(2, "0")}.jpg`,
  };
});
H.append(
  head,
  H.element("meta", {
    name: "sourceweft:artifact",
    content: JSON.stringify({
      schemaVersion: 1,
      presentation: { protocol: "presentation/v1", pages },
    }),
  }),
);
if (highlight)
  H.append(
    head,
    H.element(
      "script",
      { "data-sw-runtime": "highlight.js" },
      read(path.join(assets, "highlight.js")),
    ),
  );
if (charts) {
  H.append(
    head,
    H.element(
      "script",
      { "data-sw-runtime": "chart.js" },
      read(path.join(assets, "chart.js")).replace(/<\/script/gi, "<\\/script"),
    ),
  );
  H.append(
    head,
    H.element(
      "script",
      { "data-sw-runtime": "chart-defaults" },
      "Chart.defaults.animation=false;Chart.defaults.font.family=getComputedStyle(document.documentElement).getPropertyValue('--font-sans');Chart.defaults.font.size=18;",
    ),
  );
}
H.append(
  head,
  H.element(
    "script",
    {
      type: "application/json",
      id: "sourceweft-deck-config",
      "data-sw-runtime": "config",
    },
    JSON.stringify({
      width: ratio === "16:9" ? 1280 : 960,
      height: 720,
      animations: catalog.animations,
    }),
  ),
);
for (const file of [
  "reveal.js",
  "fx/_util.js",
  ...[...effects].map((name) => "fx/" + name + ".js"),
  "presentation.js",
])
  H.append(
    body,
    H.element(
      "script",
      { "data-sw-runtime": file },
      read(path.join(assets, file)).replace(/<\/script/gi, "<\\/script"),
    ),
  );
if (!options.layout)
  for (const n of sourceBody.childNodes || [])
    if (
      n.tagName === "script" &&
      !H.attr(n, "data-sw-runtime") &&
      !H.attr(n, "id")?.startsWith("sourceweft-")
    )
      H.append(body, n);
for (const name of [
  "html-ppt-skill",
  "reveal",
  ...(charts ? ["chart.js"] : []),
  ...(highlight ? ["highlight.js"] : []),
])
  H.append(
    head,
    H.element(
      "script",
      { type: "application/json", "data-sw-runtime": "license-" + name },
      JSON.stringify({
        name,
        license: read(path.join(home, "licenses", name + ".txt")),
      }),
    ),
  );
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
const staging = path.join(
  path.dirname(path.resolve(output)),
  ".sourceweft-deck-" + crypto.randomUUID() + ".html",
);
try {
  fs.writeFileSync(staging, H.serialize(doc));
  console.log(
    JSON.stringify(
      H.bundle({
        source: staging,
        output: path.resolve(output),
        assetRoots: [assets, path.dirname(path.resolve(source))],
        baseDirectory: path.dirname(path.resolve(source)),
        fontDirectory,
        extraText: [...effects]
          .map((name) => read(path.join(assets, "fx", name + ".js")))
          .join("\n"),
      }),
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(staging, { force: true });
}
