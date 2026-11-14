// The desktop main window opens on this bundled page and then loads the hosted web app.
// The window keeps showing this page until the web app starts rendering, so a slow
// connection shows a progress indicator instead of a blank window, and a failed one
// leaves a message and a way to retry.
//
// The shell injects `window.__SOURCEWEFT_STARTUP__` ({ url, locale }) before this runs;
// see `apps/desktop/src-tauri/src/startup_page.rs`.
(() => {
  "use strict";

  // How long the web app may take before the page says so and offers a retry.
  const SLOW_AFTER_MS = 8000;
  // Longest wait for a first frame before loading the web app anyway.
  const FIRST_PAINT_TIMEOUT_MS = 200;

  // The three locales of `@sourceweft/i18n`, written by hand as in `tray_locale.rs`.
  const MESSAGES = {
    en: {
      slow: {
        message: "This is taking longer than usual.",
        hint: "Check your network connection, then try again.",
      },
      offline: {
        message: "You appear to be offline.",
        hint: "SourceWeft will load when the connection is back.",
      },
      retry: "Try again",
    },
    "zh-CN": {
      slow: {
        message: "加载时间比平时长。",
        hint: "请检查网络连接后重试。",
      },
      offline: {
        message: "当前似乎没有网络连接。",
        hint: "网络恢复后会自动加载 SourceWeft。",
      },
      retry: "重试",
    },
    "zh-TW": {
      slow: {
        message: "載入時間比平時長。",
        hint: "請檢查網路連線後重試。",
      },
      offline: {
        message: "目前似乎沒有網路連線。",
        hint: "網路恢復後會自動載入 SourceWeft。",
      },
      retry: "重試",
    },
  };

  const config = window.__SOURCEWEFT_STARTUP__ || {};
  const locale = Object.hasOwn(MESSAGES, config.locale) ? config.locale : "en";
  const text = MESSAGES[locale];
  const target = typeof config.url === "string" ? config.url : "";

  const progress = document.getElementById("progress");
  const notice = document.getElementById("notice");
  const message = document.getElementById("message");
  const hint = document.getElementById("hint");
  const retry = document.getElementById("retry");

  let slowTimer;

  // "loading": progress only. "slow": progress and a notice. "offline": the notice alone.
  const show = (state) => {
    progress.hidden = state === "offline";
    notice.hidden = state === "loading";
    if (state !== "loading") {
      message.textContent = text[state].message;
      hint.textContent = text[state].hint;
    }
  };

  const load = () => {
    clearTimeout(slowTimer);
    if (!target) {
      show("slow");
      return;
    }
    if (navigator.onLine === false) {
      show("offline");
    } else {
      show("loading");
      slowTimer = setTimeout(() => show("slow"), SLOW_AFTER_MS);
    }
    // Attempted even when the system reports no network: that report can be wrong, and a
    // failed attempt leaves this page in place. `replace` keeps this page out of history.
    window.location.replace(target);
  };

  document.documentElement.lang = locale;
  retry.textContent = text.retry;
  retry.addEventListener("click", load);
  window.addEventListener("online", load);

  // Let the page paint once before the web app starts loading.
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    load();
  };
  requestAnimationFrame(() => requestAnimationFrame(start));
  setTimeout(start, FIRST_PAINT_TIMEOUT_MS);
})();
