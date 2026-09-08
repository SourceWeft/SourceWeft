(function () {
  "use strict";
  const U = window.HPX._u;
  const root = document.querySelector(".reveal");
  const slides = [...root.querySelector(".slides").children];
  const registry = JSON.parse(
    document.getElementById("sourceweft-deck-config").textContent,
  );
  const deck = new Reveal(root, {
    width: registry.width,
    height: registry.height,
    margin: 0.03,
    display: "flex",
    center: false,
    hash: false,
    history: false,
    controls: true,
    progress: true,
    slideNumber: "c/t",
    transition: "fade",
    embedded: window.parent !== window,
    keyboard: true,
    touch: true,
    plugins: [],
  });
  const active = new Map();
  let channel = null,
    parentOrigin = null,
    capturing = false,
    disposed = false;
  const seed = (value) => {
    let x = 2166136261;
    for (const c of value) x = Math.imul(x ^ c.charCodeAt(0), 16777619);
    return x >>> 0;
  };
  const state = () => {
    const i = deck.getIndices();
    return {
      slideIndex: i.h,
      slideCount: slides.length,
      fragmentIndex: i.f ?? -1,
      overview: deck.isOverview(),
    };
  };
  const send = (type, extra = {}) => {
    if (channel)
      parent.postMessage(
        { protocol: "presentation/v1", channelId: channel, type, ...extra },
        parentOrigin || "*",
      );
  };
  const charts = () => (window.Chart ? Object.values(Chart.instances) : []);
  const metrics = () => ({ ...U.metrics(), charts: charts().length });
  function stop() {
    for (const chart of charts()) chart.stop();
    for (const { handle, scope } of active.values()) {
      try {
        handle?.stop?.();
      } finally {
        scope.stop();
      }
    }
    active.clear();
  }
  const nodes = (root, selector) => [
    ...(root.matches(selector) ? [root] : []),
    ...root.querySelectorAll(selector),
  ];
  function mount(slide, region) {
    if (!slide || !region) return;
    nodes(region, "[data-fx]").forEach((el, index) => {
      if (active.has(el) || el.closest(".fragment:not(.visible)")) return;
      index = [...slide.querySelectorAll("[data-fx]")].indexOf(el);
      const name = el.dataset.fx;
      const implementation = window.HPX[name];
      if (typeof implementation !== "function")
        throw new Error("Missing FX: " + name);
      const scope = U.scope(seed(slide.dataset.slideId + ":" + index));
      try {
        const handle = scope.run(() => implementation(el, {}));
        active.set(el, { scope, handle });
      } catch (error) {
        scope.stop();
        throw error;
      }
    });
    nodes(region, "[data-anim],.counter").forEach((el) => {
      if (el.closest(".fragment:not(.visible)")) return;
      const name =
        el.dataset.anim ||
        (el.classList.contains("counter") ? "counter-up" : null);
      if (!registry.animations.includes(name))
        throw new Error("Unknown animation: " + name);
      el.classList.remove("anim-" + name);
      void el.offsetWidth;
      el.classList.add("anim-" + name);
      if (name === "counter-up" && !active.has(el)) {
        const target = Number(
          el.dataset.target ||
            el.dataset.to ||
            el.dataset.count ||
            el.textContent.replace(/[^\d.-]/g, ""),
        );
        if (!Number.isFinite(target))
          throw new Error("counter-up requires a finite data-target");
        const scope = U.scope(seed(slide.dataset.slideId + ":counter"));
        const decimals = Number(
          el.dataset.decimals || (target % 1 === 0 ? 0 : 1),
        );
        const duration = Number(el.dataset.dur || 1200) / 1000;
        scope.run(() => {
          let end;
          end = U.loop((t) => {
            el.textContent = (
              target *
              (1 - Math.pow(1 - Math.min(1, t / duration), 3))
            ).toFixed(decimals);
            if (t >= duration) end();
          });
        });
        active.set(el, { scope, handle: null });
      }
    });
  }
  function start() {
    stop();
    if (disposed || document.hidden || deck.isOverview()) return;
    const slide = deck.getCurrentSlide();
    if (!slide) return;
    document.body.style.background =
      getComputedStyle(slide).getPropertyValue("--bg");
    root.style.setProperty(
      "--r-link-color",
      getComputedStyle(slide).getPropertyValue("--accent"),
    );
    mount(slide, slide);
    for (const chart of charts())
      if (slide.contains(chart.canvas)) {
        chart.resize();
        chart.update("none");
      }
  }
  function fragmentShown(event) {
    if (!capturing) mount(deck.getCurrentSlide(), event.fragment);
    send("state", { state: state() });
  }
  function fragmentHidden(event) {
    for (const [el, item] of [...active])
      if (event.fragment === el || event.fragment.contains(el)) {
        try {
          item.handle?.stop?.();
        } finally {
          item.scope.stop();
          active.delete(el);
        }
      }
    send("state", { state: state() });
  }
  function changed() {
    if (!capturing) start();
    send("state", { state: state() });
  }
  function message(event) {
    const d = event.data;
    if (event.source !== parent || !d || d.protocol !== "presentation/v1")
      return;
    if (d.type === "init") {
      if (
        typeof d.channelId !== "string" ||
        d.channelId.length < 16 ||
        d.channelId.length > 128
      )
        return;
      channel = d.channelId;
      parentOrigin = event.origin === "null" ? "*" : event.origin;
      Promise.resolve(ready).then(() => send("ready", { state: state() }));
      return;
    }
    if (
      d.channelId !== channel ||
      d.type !== "command" ||
      typeof d.requestId !== "string" ||
      d.requestId.length > 128
    )
      return;
    try {
      if (d.command === "next") deck.next();
      else if (d.command === "prev") deck.prev();
      else if (
        d.command === "goto" &&
        Number.isInteger(d.slideIndex) &&
        d.slideIndex >= 0 &&
        d.slideIndex < slides.length
      )
        deck.slide(d.slideIndex);
      else if (d.command === "overview" && typeof d.enabled === "boolean")
        deck.toggleOverview(d.enabled);
      else throw new Error("Unsupported presentation command");
      send("ack", { requestId: d.requestId, state: state() });
    } catch (error) {
      send("error", {
        requestId: d.requestId,
        message: String(error.message).slice(0, 500),
      });
    }
  }
  const onVisibility = () => (document.hidden ? stop() : start());
  const ready = deck.initialize().then(async () => {
    if (window.hljs)
      for (const el of root.querySelectorAll('pre code[class*="language-"]')) {
        const language = [...el.classList]
          .find((c) => c.startsWith("language-"))
          .slice(9);
        if (!hljs.getLanguage(language))
          throw new Error("Unsupported code language: " + language);
        hljs.highlightElement(el);
      }
    await document.fonts.ready;
    start();
    return true;
  });
  deck.on("slidechanged", changed);
  deck.on("fragmentshown", fragmentShown);
  deck.on("fragmenthidden", fragmentHidden);
  deck.on("overviewshown", () => {
    stop();
    send("state", { state: state() });
  });
  deck.on("overviewhidden", changed);
  deck.on("resize", () => {
    if (!capturing) start();
  });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("message", message);
  const fullscreen = document.createElement("button");
  fullscreen.className = "sw-fullscreen";
  fullscreen.textContent = "Fullscreen";
  fullscreen.setAttribute("aria-label", "Enter fullscreen");
  fullscreen.onclick = () => {
    if (!document.documentElement.requestFullscreen) {
      fullscreen.textContent = "Fullscreen unavailable";
      return;
    }
    document.documentElement.requestFullscreen().catch(() => {
      fullscreen.textContent = "Fullscreen unavailable";
    });
  };
  document.body.appendChild(fullscreen);
  window.__sourceweftPresentationQA = {
    ready,
    slides,
    deck,
    async capture(index, milliseconds = 500) {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= slides.length ||
        !Number.isFinite(milliseconds) ||
        milliseconds < 0 ||
        milliseconds > 10000
      )
        throw new Error("Capture request is out of bounds");
      await ready;
      capturing = true;
      stop();
      deck.toggleOverview(false);
      deck.slide(index, 0, 1000);
      void deck.getCurrentSlide().offsetHeight;
      await document.fonts.ready;
      deck.layout();
      capturing = false;
      start();
      capturing = true;
      document.documentElement.classList.add("sw-capture");
      document.documentElement.style.setProperty(
        "--sw-capture-delay",
        "-" + milliseconds + "ms",
      );
      for (const { scope } of active.values()) U.capture(scope, milliseconds);
      deck
        .getCurrentSlide()
        .querySelectorAll("[data-anim]")
        .forEach((el) => {
          el.style.animationDelay = "-" + milliseconds + "ms";
          el.style.animationPlayState = "paused";
        });
      return { state: state(), metrics: metrics() };
    },
    async resume() {
      await ready;
      capturing = false;
      document.documentElement.classList.remove("sw-capture");
      document.documentElement.style.removeProperty("--sw-capture-delay");
      for (const el of root.querySelectorAll("[data-anim]")) {
        el.style.animationDelay = "";
        el.style.animationPlayState = "";
      }
      start();
    },
    metrics,
    async dispose() {
      disposed = true;
      stop();
      for (const chart of charts()) chart.destroy();
      window.removeEventListener("message", message);
      document.removeEventListener("visibilitychange", onVisibility);
      fullscreen.remove();
      await deck.destroy();
    },
  };
})();
