"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const dependency = require("./dependencies.cjs");
const { parse, serialize, serializeOuter } = dependency("parse5");
const postcss = dependency("postcss");
const valueParser = dependency("postcss-value-parser");

const readText = (file) =>
  new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}
function attr(node, name) {
  return node.attrs?.find((a) => a.name === name)?.value;
}
function setAttr(node, name, value) {
  node.attrs ||= [];
  const entry = node.attrs.find((a) => a.name === name);
  if (entry) entry.value = String(value);
  else node.attrs.push({ name, value: String(value) });
}
function element(tag, attrs = {}, content = "") {
  const doc = parse(`<html><head></head><body><${tag}></${tag}></body></html>`);
  let found;
  walk(doc, (n) => {
    if (n.tagName === tag) found = n;
  });
  if (!found) {
    found = {
      nodeName: tag,
      tagName: tag,
      namespaceURI: "http://www.w3.org/1999/xhtml",
      attrs: [],
      childNodes: [],
    };
  }
  for (const [name, value] of Object.entries(attrs))
    setAttr(found, name, value);
  if (content)
    found.childNodes = [
      { nodeName: "#text", value: content, parentNode: found },
    ];
  return found;
}
function append(parent, node) {
  node.parentNode = parent;
  parent.childNodes ||= [];
  parent.childNodes.push(node);
}
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".gif": "image/gif",
};
function bundle({
  source,
  output,
  assetRoots = [],
  fontDirectory,
  extraText = "",
  baseDirectory,
}) {
  source = fs.realpathSync(source);
  const roots = [
    path.dirname(source),
    ...(baseDirectory ? [fs.realpathSync(baseDirectory)] : []),
    ...assetRoots.map((p) => fs.realpathSync(p)),
  ];
  const resolve = (reference, base) => {
    if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(reference))
      throw new Error(
        "External resource must be provided locally: " + reference,
      );
    const resolved = fs.realpathSync(
      path.resolve(base, decodeURIComponent(reference.split(/[?#]/)[0])),
    );
    if (
      !roots.some(
        (root) => resolved === root || resolved.startsWith(root + path.sep),
      )
    )
      throw new Error("Resource escapes authorized roots: " + reference);
    return resolved;
  };
  const data = (reference, base) => {
    if (reference.startsWith("data:") || reference.startsWith("#"))
      return reference;
    const file = resolve(reference, base);
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime) throw new Error("Unsupported embedded resource: " + file);
    return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  };
  const css = (text, base, seen = new Set()) => {
    const sheet = postcss.parse(text);
    sheet.walkAtRules("import", (rule) => {
      const nodes = valueParser(rule.params).nodes.filter(
        (n) => n.type !== "space",
      );
      if (nodes.length !== 1)
        throw new Error(
          "Conditional CSS imports must be resolved by the author",
        );
      const n = nodes[0];
      const reference =
        n.type === "string"
          ? n.value
          : n.type === "function" && n.value === "url"
            ? n.nodes[0]?.value
            : null;
      if (!reference) throw new Error("Unresolved CSS import");
      const file = resolve(reference, base);
      if (seen.has(file)) throw new Error("Cyclic CSS import: " + file);
      rule.replaceWith(
        postcss.parse(
          css(readText(file), path.dirname(file), new Set([...seen, file])),
        ),
      );
    });
    sheet.walkDecls((decl) => {
      const value = valueParser(decl.value);
      value.walk((node) => {
        if (node.type === "function" && node.value.toLowerCase() === "url") {
          const ref = valueParser
            .stringify(node.nodes)
            .trim()
            .replace(/^(['"])(.*)\1$/s, "$2");
          node.nodes = [{ type: "word", value: data(ref, base) }];
        }
      });
      decl.value = value.toString();
    });
    return sheet.toString();
  };
  const doc = parse(readText(source), { sourceCodeLocationInfo: true });
  let head, body, html;
  walk(doc, (n) => {
    if (n.tagName === "head") head = n;
    if (n.tagName === "body") body = n;
    if (n.tagName === "html") html = n;
  });
  if (!html?.sourceCodeLocation?.startTag || !html.sourceCodeLocation.endTag)
    throw new Error("A complete HTML document is required");
  const base = baseDirectory || path.dirname(source);
  const externalScripts = new Set();
  const nodes = [];
  walk(doc, (n) => nodes.push(n));
  for (const node of nodes) {
    if (!node.tagName) continue;
    if (["iframe", "frame", "object", "embed", "base"].includes(node.tagName))
      throw new Error("Unsupported local document element: " + node.tagName);
    if (node.tagName === "link" && attr(node, "rel") === "stylesheet") {
      const file = resolve(attr(node, "href"), base);
      const style = element(
        "style",
        {},
        css(readText(file), path.dirname(file)),
      );
      const index = node.parentNode.childNodes.indexOf(node);
      style.parentNode = node.parentNode;
      node.parentNode.childNodes[index] = style;
      continue;
    }
    if (node.tagName === "script" && attr(node, "src")) {
      externalScripts.add(node);
      const file = resolve(attr(node, "src"), base);
      node.attrs = node.attrs.filter((a) => a.name !== "src");
      node.childNodes = [
        {
          nodeName: "#text",
          value: readText(file).replace(/<\/script/gi, "<\\/script"),
          parentNode: node,
        },
      ];
    }
    if (node.tagName === "style")
      node.childNodes = [
        {
          nodeName: "#text",
          value: css(
            (node.childNodes || []).map((c) => c.value || "").join(""),
            base,
          ),
          parentNode: node,
        },
      ];
    for (const name of ["src", "poster", "background"])
      if (attr(node, name)) setAttr(node, name, data(attr(node, name), base));
    for (const name of ["href", "xlink:href"])
      if (attr(node, name) && node.tagName !== "a")
        setAttr(node, name, data(attr(node, name), base));
    if (attr(node, "srcset")) {
      const input = attr(node, "srcset");
      let i = 0;
      const candidates = [];
      while (i < input.length) {
        while (i < input.length && /[\s,]/.test(input[i])) i++;
        const start = i;
        while (i < input.length && !/\s/.test(input[i])) i++;
        const token = input.slice(start, i);
        if (!token) break;
        const url = token.replace(/,+$/, "");
        let descriptors = "";
        if (!token.endsWith(",")) {
          const start = i;
          while (i < input.length && input[i] !== ",") i++;
          descriptors = input.slice(start, i).trim();
          i++;
        }
        candidates.push(
          data(url, base) + (descriptors ? " " + descriptors : ""),
        );
      }
      setAttr(node, "srcset", candidates.join(", "));
    }
    if (attr(node, "style"))
      setAttr(
        node,
        "style",
        css(`x{${attr(node, "style")}}`, base).slice(2, -1),
      );
  }
  // Rebuilding an already published file replaces font evidence instead of accumulating it.
  walk(doc, (n) => {
    if (n.childNodes)
      n.childNodes = n.childNodes.filter(
        (c) =>
          ![
            "sourceweft-font-faces",
            "sourceweft-font-evidence",
            "sourceweft-font-licenses",
          ].includes(attr(c, "id")),
      );
  });
  let text = extraText + "“”‘’•… ";
  walk(doc, (n) => {
    if (
      n.nodeName === "#text" &&
      n.parentNode?.tagName !== "style" &&
      !(
        n.parentNode?.tagName === "script" &&
        (attr(n.parentNode, "data-sw-runtime") ||
          externalScripts.has(n.parentNode))
      )
    )
      text += n.value;
    if (n.tagName === "style")
      postcss
        .parse((n.childNodes || []).map((c) => c.value || "").join(""))
        .walkDecls((d) => {
          if (d.prop === "content" || d.prop.startsWith("--"))
            valueParser(d.value).walk((v) => {
              if (v.type === "string" && !v.value.startsWith("data:"))
                text += v.value.replace(/\\([a-f\d]{1,6})\s?/gi, (_, hex) =>
                  String.fromCodePoint(parseInt(hex, 16)),
                );
            });
        });
    for (const a of n.attrs || [])
      if (!a.value.startsWith("data:")) text += a.value;
  });
  text = text.replace(/\\u\{([a-f\d]+)\}|\\u([a-f\d]{4})/gi, (_, a, b) =>
    String.fromCodePoint(parseInt(a || b, 16)),
  );
  if (!fontDirectory)
    throw new Error(
      "SOURCEWEFT_HTML_FONTS is required; provision the pinned HTML runtime first",
    );
  const catalog = JSON.parse(
    readText(path.join(fontDirectory, "catalog.json")),
  );
  const htmlText = serialize(doc);
  const families = [
    ...new Set(
      catalog.files
        .filter(
          (f) =>
            f.path.endsWith(".ttf") &&
            htmlText.toLowerCase().includes(f.family.toLowerCase()),
        )
        .map((f) => f.family),
    ),
  ];
  for (const family of catalog.defaultFamilies)
    if (!families.includes(family)) families.push(family);
  const result = spawnSync(
    process.env.SOURCEWEFT_PYTHON || "python3",
    [path.join(__dirname, "subset_fonts.py")],
    {
      input: JSON.stringify({ directory: fontDirectory, text, families }),
      encoding: "utf8",
      maxBuffer: 30 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || "Font subsetting failed");
  const fonts = JSON.parse(result.stdout);
  const defaults = element(
    "style",
    { id: "sourceweft-font-faces" },
    fonts.css +
      "\nhtml,body{font-family:" +
      catalog.defaultFamilies.map((f) => JSON.stringify(f)).join(",") +
      "}",
  );
  const metadata = head.childNodes.filter(
    (n) => n.tagName === "meta" && !attr(n, "charset"),
  );
  const other = head.childNodes.filter((n) => n.tagName !== "meta");
  const charset = element("meta", { charset: "utf-8" });
  const icon = other.some(
    (node) =>
      node.tagName === "link" &&
      (attr(node, "rel") || "").split(/\s+/).includes("icon"),
  )
    ? []
    : [
        element("link", {
          rel: "icon",
          href:
            "data:image/svg+xml;base64," +
            Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"></svg>',
            ).toString("base64"),
        }),
      ];
  head.childNodes = [charset, ...icon, ...metadata, defaults, ...other];
  for (const child of head.childNodes) child.parentNode = head;
  append(
    head,
    element(
      "script",
      { type: "application/json", id: "sourceweft-font-evidence" },
      JSON.stringify({
        families: fonts.families,
        codepoints: fonts.codepoints,
        familyCodepoints: fonts.familyCodepoints,
      }),
    ),
  );
  append(
    head,
    element(
      "script",
      { type: "application/json", id: "sourceweft-font-licenses" },
      JSON.stringify(fonts.licenses).replace(/<\/script/gi, "<\\/script"),
    ),
  );
  const bytes = Buffer.from(serialize(doc));
  if (bytes.length > 25 * 1024 * 1024) throw new Error("HTML exceeds 25 MiB");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, bytes);
  return {
    file: output,
    bytes: bytes.length,
    contentDigest:
      "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}
module.exports = {
  postcss,
  bundle,
  walk,
  attr,
  setAttr,
  element,
  append,
  parse,
  serialize,
  serializeOuter,
};
if (require.main === module) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output)
    throw new Error("Usage: node bundle.cjs source.html output.html");
  console.log(
    JSON.stringify(
      bundle({
        source,
        output,
        fontDirectory: process.env.SOURCEWEFT_HTML_FONTS,
      }),
      null,
      2,
    ),
  );
}
