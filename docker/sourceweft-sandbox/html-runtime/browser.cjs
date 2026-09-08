"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const browsers = require("./dependencies.cjs")("playwright");
const CSP =
  "sandbox allow-scripts allow-forms allow-modals; default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors 'self'";
async function openDocument(
  file,
  viewport,
  { standalone = false, bytes: providedBytes, engine = "chromium" } = {},
) {
  const bytes = providedBytes || fs.readFileSync(file);
  if (bytes.length > 25 * 1024 * 1024) throw new Error("HTML exceeds 25 MiB");
  if (!["chromium", "firefox", "webkit"].includes(engine))
    throw new Error("Unsupported browser engine");
  const browser = await browsers[engine].launch({ headless: true });
  const context = await browser.newContext({
    viewport,
    offline: engine === "chromium" || (standalone && engine === "firefox"),
    locale: "en-US",
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const failures = [],
    requests = [];
  const url = standalone
    ? pathToFileURL(path.resolve(file)).href
    : "https://artifact.test/index.html";
  await context.route("**/*", async (route) => {
    const r = route.request();
    if (
      r.url() === url &&
      r.isNavigationRequest() &&
      r.frame() === page.mainFrame()
    ) {
      if (standalone) await route.continue();
      else
        await route.fulfill({
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": CSP,
          },
          body: bytes,
        });
    } else {
      requests.push(r.url());
      await route.abort();
    }
  });
  page.on("pageerror", (e) => failures.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") failures.push(m.text());
  });
  page.on("websocket", (s) => requests.push(s.url()));
  await page.addInitScript(() => {
    window.__sourceweftQaViolations = [];
    window.__sourceweftCanvasFonts = [];
    window.__sourceweftCanvasText = new Map();
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__sourceweftQaViolations.push(
        e.violatedDirective + ":" + e.blockedURI,
      ),
    );
    const descriptor = Object.getOwnPropertyDescriptor(
      CanvasRenderingContext2D.prototype,
      "font",
    );
    for (const name of ["fillText", "strokeText"]) {
      const original = CanvasRenderingContext2D.prototype[name];
      CanvasRenderingContext2D.prototype[name] = function (text, ...args) {
        if (window.__sourceweftCanvasText.size < 20000)
          window.__sourceweftCanvasText.set(this.font + "\0" + String(text), {
            font: this.font,
            text: String(text),
          });
        return original.call(this, text, ...args);
      };
    }
    if (descriptor?.set && descriptor.get)
      Object.defineProperty(CanvasRenderingContext2D.prototype, "font", {
        ...descriptor,
        set(value) {
          window.__sourceweftCanvasFonts.push(String(value));
          descriptor.set.call(this, value);
        },
      });
  });
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
  } catch (error) {
    await browser.close();
    throw error;
  }
  return {
    browser,
    context,
    page,
    failures,
    requests,
    networkMode:
      engine === "chromium" || (standalone && engine === "firefox")
        ? "offline-before-navigation"
        : "intercept-all-network",
    contentDigest:
      "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex"),
    async close() {
      await browser.close();
    },
  };
}
async function inspect(
  session,
  selector = "body",
  { minimumBodyFont = 0 } = {},
) {
  const result = await session.page.evaluate(
    ({ selector, minimumBodyFont }) => {
      const root = document.querySelector(selector);
      if (!root) throw new Error("QA root not found: " + selector);
      const issues = [];
      const box = root.getBoundingClientRect();
      for (const image of root.querySelectorAll("img"))
        if (!image.complete || image.naturalWidth === 0)
          issues.push(
            "image failed to load: " +
              (image.alt || image.getAttribute("src")?.slice(0, 80)),
          );
      if (location.protocol !== "file:") {
        if (self.origin !== "null")
          issues.push("Document did not receive an opaque origin");
        for (const name of ["localStorage", "sessionStorage"]) {
          try {
            void window[name].length;
            issues.push("Sandbox unexpectedly permits " + name);
          } catch {}
        }
      }
      const evidence = document.getElementById("sourceweft-font-evidence");
      if (!evidence) issues.push("embedded font evidence is missing");
      const fonts = evidence
        ? JSON.parse(evidence.textContent)
        : { families: [], codepoints: [] };
      const coverage = new Set(fonts.codepoints);
      const byFamily = new Map(
        Object.entries(fonts.familyCodepoints || {}).map(([name, points]) => [
          name.toLowerCase(),
          new Set(points),
        ]),
      );
      function checkFont(text, font, canvas = false) {
        const familyText = canvas
          ? font.replace(/^.*?\d+(?:\.\d+)?px\s+/, "")
          : font;
        const chain = [
          ...familyText.matchAll(/"([^"]+)"|'([^']+)'|([^,]+)/g),
        ].map((m) =>
          (m[1] || m[2] || m[3])
            .trim()
            .replace(/^['"]|['"]$/g, "")
            .toLowerCase(),
        );
        const known = chain.filter((f) => byFamily.has(f));
        if (
          !known.length ||
          !byFamily.has(chain[0]) ||
          chain.some(
            (f) =>
              !byFamily.has(f) &&
              ![
                "serif",
                "sans-serif",
                "monospace",
                "cursive",
                "fantasy",
                "system-ui",
              ].includes(f),
          )
        )
          issues.push("unembedded font family: " + font);
        const missing = [
          ...new Set(
            [...text].filter(
              (c) =>
                !/[\p{Control}\p{Default_Ignorable_Code_Point}]/u.test(c) &&
                !known.some((f) => byFamily.get(f).has(c.codePointAt(0))),
            ),
          ),
        ];
        if (missing.length)
          issues.push(
            "missing rendered glyphs for " + font + ": " + missing.join(""),
          );
      }
      for (const element of root.querySelectorAll("*")) {
        const style = getComputedStyle(element),
          rect = element.getBoundingClientRect();
        if (
          !rect.width ||
          !rect.height ||
          style.visibility === "hidden" ||
          style.display === "none" ||
          element.closest("script,style,.notes")
        )
          continue;
        const text = [...element.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join("")
          .trim();
        if (!text) continue;
        if (
          minimumBodyFont &&
          ["P", "LI", "TD", "TH", "PRE", "CODE"].includes(element.tagName) &&
          parseFloat(style.fontSize) < minimumBodyFont &&
          !element.closest('[data-text-role="decoration"]')
        )
          issues.push(
            "body font below " + minimumBodyFont + "px: " + text.slice(0, 40),
          );
        checkFont(text, style.fontFamily);
        if (
          minimumBodyFont &&
          (rect.left < box.left - 2 ||
            rect.right > box.right + 2 ||
            rect.top < box.top - 2 ||
            rect.bottom > box.bottom + 2) &&
          !element.closest('[data-text-role="decoration"]')
        )
          issues.push("content outside slide: " + text.slice(0, 40));
      }
      for (const item of window.__sourceweftCanvasText?.values() || [])
        checkFont(item.text, item.font, true);
      for (const font of document.fonts)
        if (font.status === "error")
          issues.push("font failed to decode: " + font.family);
      return {
        issues: [...new Set(issues)],
        violations: window.__sourceweftQaViolations || [],
        height: document.documentElement.scrollHeight,
        width: document.documentElement.scrollWidth,
      };
    },
    { selector, minimumBodyFont },
  );
  return {
    ...result,
    issues: [
      ...new Set([
        ...result.issues,
        ...result.violations,
        ...session.failures,
        ...session.requests.map((url) => "external request: " + url),
      ]),
    ],
  };
}
module.exports = { CSP, openDocument, inspect };
