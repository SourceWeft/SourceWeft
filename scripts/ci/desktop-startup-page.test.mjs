import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const page = resolve(root, "apps/desktop/startup-dist");
const html = readFileSync(resolve(page, "index.html"), "utf8");
const script = readFileSync(resolve(page, "startup.js"), "utf8");

const WEB_APP = "https://sourceweft.com/dashboard/chat";
const IDS = ["progress", "notice", "message", "hint", "retry"];

/** Runs the page script against a minimal stand-in for the window it runs in. */
function open(options = {}) {
  // `config: undefined` is a case of its own: the shell injected nothing.
  const config =
    "config" in options ? options.config : { url: WEB_APP, locale: "en" };
  const onLine = options.onLine ?? true;
  const element = () => {
    const listeners = {};
    return {
      hidden: false,
      textContent: "",
      addEventListener: (type, handler) => (listeners[type] = handler),
      dispatch: (type) => listeners[type]?.(),
    };
  };
  const elements = Object.fromEntries(IDS.map((id) => [id, element()]));
  // As in index.html, where only the notice starts hidden.
  elements.notice.hidden = true;

  const loads = [];
  const frames = [];
  const timers = new Map();
  const windowListeners = {};
  let nextTimer = 1;
  let now = 0;

  const context = {
    window: {
      __SOURCEWEFT_STARTUP__: config,
      location: { replace: (url) => loads.push(url) },
      addEventListener: (type, handler) => (windowListeners[type] = handler),
    },
    document: {
      documentElement: { lang: "" },
      getElementById: (id) => elements[id],
    },
    navigator: { onLine },
    requestAnimationFrame: (callback) => frames.push(callback),
    setTimeout: (callback, delay) => {
      timers.set(nextTimer, { callback, at: now + delay });
      return nextTimer++;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(script, context);

  return {
    elements,
    loads,
    lang: () => context.document.documentElement.lang,
    navigator: context.navigator,
    /** Paints the frames the page asked for, including those asked for while painting. */
    paint() {
      while (frames.length) frames.shift()();
    },
    /** Lets `ms` pass, running the timers that come due. */
    wait(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.delete(id)) timer.callback();
      }
    },
    emit: (type) => windowListeners[type]?.(),
  };
}

test("the page shows progress, then loads the web app once it has painted", () => {
  const view = open();
  assert.deepEqual(view.loads, [], "nothing loads before the first frame");
  assert.equal(view.elements.progress.hidden, false);
  assert.equal(view.elements.notice.hidden, true);

  view.paint();
  assert.deepEqual(view.loads, [WEB_APP]);
  assert.equal(view.elements.progress.hidden, false);
  assert.equal(view.elements.notice.hidden, true);

  // The fallback timer for a window that never paints must not load it a second time.
  view.wait(1000);
  assert.deepEqual(view.loads, [WEB_APP]);
});

test("a window that never paints still loads the web app", () => {
  const view = open();
  view.wait(200);
  assert.deepEqual(view.loads, [WEB_APP]);
});

test("a slow load says so and offers a retry, while it keeps loading", () => {
  const view = open();
  view.paint();
  view.wait(7999);
  assert.equal(view.elements.notice.hidden, true);

  view.wait(1);
  assert.equal(view.elements.notice.hidden, false);
  assert.equal(view.elements.progress.hidden, false);
  assert.equal(
    view.elements.message.textContent,
    "This is taking longer than usual.",
  );
  assert.equal(view.elements.retry.textContent, "Try again");

  view.elements.retry.dispatch("click");
  assert.deepEqual(view.loads, [WEB_APP, WEB_APP]);
  assert.equal(view.elements.notice.hidden, true, "a retry starts over");

  view.wait(8000);
  assert.equal(view.elements.notice.hidden, false, "and is timed again");
});

test("without a network the page says so at once, and loads when it returns", () => {
  const view = open({ onLine: false });
  view.paint();
  assert.equal(view.elements.notice.hidden, false);
  assert.equal(view.elements.progress.hidden, true);
  assert.equal(view.elements.message.textContent, "You appear to be offline.");
  // The system's report can be wrong, so the load is attempted regardless.
  assert.deepEqual(view.loads, [WEB_APP]);

  view.navigator.onLine = true;
  view.emit("online");
  assert.deepEqual(view.loads, [WEB_APP, WEB_APP]);
  assert.equal(view.elements.notice.hidden, true);
  assert.equal(view.elements.progress.hidden, false);
});

test("the page speaks the locale it is given, and English otherwise", () => {
  const texts = (locale) => {
    const view = open({ config: { url: WEB_APP, locale } });
    view.paint();
    view.wait(8000);
    return {
      lang: view.lang(),
      message: view.elements.message.textContent,
      hint: view.elements.hint.textContent,
      retry: view.elements.retry.textContent,
    };
  };
  const english = texts("en");
  assert.equal(english.lang, "en");

  assert.equal(texts("zh-CN").retry, "重试");
  assert.equal(texts("zh-TW").retry, "重試");
  for (const locale of ["zh-CN", "zh-TW"]) {
    const local = texts(locale);
    assert.equal(local.lang, locale);
    for (const key of ["message", "hint", "retry"]) {
      assert(local[key].length > 0, `${locale} ${key}`);
      assert.notEqual(
        local[key],
        english[key],
        `${locale} ${key} is translated`,
      );
    }
  }

  for (const locale of ["fr", "", undefined, "__proto__", "constructor"]) {
    assert.deepEqual(texts(locale), english, `locale ${String(locale)}`);
  }
});

test("without an address to load, the page shows the notice instead of a blank window", () => {
  for (const config of [undefined, {}, { url: 42, locale: "en" }]) {
    const view = open({ config });
    view.paint();
    assert.deepEqual(view.loads, []);
    assert.equal(view.elements.notice.hidden, false);
  }
});

test("the page is self-contained: it has to render with no network", () => {
  for (const id of IDS) {
    assert(html.includes(`id="${id}"`), `index.html has #${id}`);
  }
  assert.match(html, /<div class="notice" id="notice" role="status" hidden>/);

  const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(
    ([, url]) => url,
  );
  assert.deepEqual(references.sort(), ["icon.svg", "startup.js"]);
  for (const file of references) {
    assert(existsSync(resolve(page, file)), `${file} is bundled`);
  }
  assert.doesNotMatch(
    html + script,
    /https?:\/\//,
    "nothing is fetched from a server",
  );
});

test("the window can be moved from this page", () => {
  assert.match(html, /<div class="drag" data-tauri-drag-region><\/div>/);

  // `main` fills the window and comes after the strip in the document, so a strip with
  // no stacking order of its own never receives the pointer.
  const rule = html.match(/\.drag \{([^}]*)\}/)?.[1] ?? "";
  assert.match(rule, /position: fixed;/);
  assert.match(
    rule,
    /z-index: [1-9]/,
    "the strip sits above the content that fills the window",
  );
});

test("the bundled pages of the desktop app are this page", () => {
  const config = JSON.parse(
    readFileSync(
      resolve(root, "apps/desktop/src-tauri/tauri.conf.json"),
      "utf8",
    ),
  );
  assert.equal(config.build.frontendDist, "../startup-dist");
});

test("the mark is the one the icon pipeline generates", () => {
  assert.equal(
    readFileSync(resolve(page, "icon.svg"), "utf8"),
    readFileSync(resolve(root, "apps/web/public/icon.svg"), "utf8"),
  );
  assert.match(
    readFileSync(resolve(root, "scripts/generate-icons.mjs"), "utf8"),
    /genSquareSVG\(join\(TARGETS\.tauriStartup, "icon\.svg"\)/,
  );
});
