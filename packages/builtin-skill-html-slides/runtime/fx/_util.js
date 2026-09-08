/* Adapted from html-ppt-skill f3a8435. Scoped clocks, fonts and cleanup are SourceWeft additions. */
(function () {
  "use strict";
  window.HPX = window.HPX || {};
  const U = (window.HPX._u = {});
  const scopes = new Set();
  let current = null;
  U.css = (el, name, fb) =>
    getComputedStyle(el).getPropertyValue(name).trim() || fb;
  U.accent = (el, fb) => U.css(el, "--accent", fb || "#7c5cff");
  U.accent2 = (el, fb) => U.css(el, "--accent-2", fb || "#22d3ee");
  U.text = (el, fb) => U.css(el, "--text-1", fb || "#eaeaf2");
  U.palette = (el) => [
    U.accent(el),
    U.accent2(el),
    U.css(el, "--good", "#22c55e"),
    U.css(el, "--warn", "#f59e0b"),
    U.css(el, "--bad", "#ef4444"),
  ];
  U.font = (el, kind = "sans") =>
    U.css(el, "--font-" + kind, getComputedStyle(el).fontFamily);
  const run = (scope, fn) => {
    const previous = current;
    current = scope;
    try {
      return fn();
    } finally {
      current = previous;
    }
  };
  U.scope = (seed = 1) => {
    let value = seed >>> 0;
    const scope = {
      stopped: false,
      loops: new Set(),
      timers: new Map(),
      cleanups: new Set(),
      capture: false,
      time: 0,
      random() {
        value += 0x6d2b79f5;
        let x = value;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      },
      run(fn) {
        return run(scope, fn);
      },
      stop() {
        scope.stopped = true;
        for (const loop of scope.loops) cancelAnimationFrame(loop.id);
        for (const id of scope.timers.keys()) clearTimeout(id);
        scope.loops.clear();
        scope.timers.clear();
        for (const cleanup of scope.cleanups) cleanup();
        scope.cleanups.clear();
        scopes.delete(scope);
      },
    };
    scopes.add(scope);
    return scope;
  };
  U.random = () => (current ? current.random() : Math.random());
  U.rand = (a, b) => a + U.random() * (b - a);
  U.canvas = (el) => {
    if (!current) throw new Error("FX must run in a lifecycle scope");
    if (getComputedStyle(el).position === "static")
      el.style.position = "relative";
    const c = document.createElement("canvas");
    c.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:block";
    el.appendChild(c);
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    let w, h, dpr;
    const fit = () => {
      w = Math.max(1, el.clientWidth);
      h = Math.max(1, el.clientHeight);
      dpr = Math.max(1, Math.min(2, devicePixelRatio || 1));
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    const scope = current;
    const destroy = () => {
      ro.disconnect();
      c.remove();
      scope.cleanups.delete(destroy);
    };
    scope.cleanups.add(destroy);
    return {
      c,
      ctx,
      get w() {
        return w;
      },
      get h() {
        return h;
      },
      get dpr() {
        return dpr;
      },
      destroy,
    };
  };
  U.loop = (fn) => {
    const scope = current;
    if (!scope) throw new Error("FX loop has no lifecycle scope");
    const loop = { id: 0, start: performance.now(), fn };
    scope.loops.add(loop);
    const tick = (t) => {
      if (scope.stopped || !scope.loops.has(loop) || scope.capture) return;
      run(scope, () => fn((t - loop.start) / 1000));
      loop.id = requestAnimationFrame(tick);
    };
    loop.id = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(loop.id);
      scope.loops.delete(loop);
    };
  };
  U.timeout = (fn, delay) => {
    const scope = current;
    if (!scope) throw new Error("FX timer has no lifecycle scope");
    const item = { fn, delay, due: scope.time + delay };
    const id = setTimeout(() => {
      if (scope.capture || scope.stopped) return;
      scope.timers.delete(id);
      run(scope, fn);
    }, delay);
    scope.timers.set(id, item);
    return id;
  };
  U.interval = (fn, delay) => {
    const scope = current;
    let stopped = false,
      id;
    const tick = () => {
      if (stopped || scope.stopped) return;
      fn();
      id = U.timeout(tick, delay);
    };
    id = U.timeout(tick, delay);
    return () => {
      stopped = true;
      clearTimeout(id);
      scope.timers.delete(id);
    };
  };
  U.capture = (scope, milliseconds) => {
    scope.capture = true;
    for (const loop of scope.loops) cancelAnimationFrame(loop.id);
    for (const id of scope.timers.keys()) clearTimeout(id);
    for (let t = 0; t <= milliseconds; t += 1000 / 60) {
      scope.time = t;
      for (const loop of scope.loops) run(scope, () => loop.fn(t / 1000));
      for (const [id, timer] of [...scope.timers])
        if (timer.due <= t) {
          clearTimeout(id);
          scope.timers.delete(id);
          run(scope, timer.fn);
        }
    }
    for (const id of scope.timers.keys()) clearTimeout(id);
  };
  U.metrics = () => ({
    scopes: scopes.size,
    loops: [...scopes].reduce((n, s) => n + s.loops.size, 0),
    timers: [...scopes].reduce((n, s) => n + s.timers.size, 0),
    observers: [...scopes].reduce((n, s) => n + s.cleanups.size, 0),
  });
})();
