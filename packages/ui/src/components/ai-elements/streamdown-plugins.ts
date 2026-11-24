"use client";

import { cjk } from "@streamdown/cjk";
import { useEffect, useMemo, useState } from "react";
import type { PluginConfig } from "streamdown";

/**
 * Streamdown's code, math and diagram plugins import shiki, KaTeX and mermaid
 * up front: together most of a megabyte of script that every page showing a
 * message would load and run before it can start, even with no message on
 * screen. Each is loaded the first time some markdown needs it instead, and
 * kept for every later render. Until it arrives the markdown renders without
 * it: a code block unhighlighted, a formula or diagram as its source.
 */
type LazyPlugin = "code" | "math" | "mermaid";

const loaders: Record<
  LazyPlugin,
  () => Promise<NonNullable<PluginConfig[LazyPlugin]>>
> = {
  code: () => import("@streamdown/code").then((module) => module.code),
  math: () => import("@streamdown/math").then((module) => module.math),
  mermaid: () => import("@streamdown/mermaid").then((module) => module.mermaid),
};

const loaded: PluginConfig = { cjk };
const loading = new Map<LazyPlugin, Promise<void>>();

// A fence opens a line, after at most three spaces of indentation.
const FENCE = /(^|\n) {0,3}(`{3,}|~{3,})/;
const MERMAID_FENCE = /(^|\n) {0,3}(`{3,}|~{3,})[ \t]*mermaid\b/i;

/** The lazy plugins a piece of markdown needs. Math is `$$` only: single-dollar math is off. */
export function pluginsNeededBy(markdown: string): LazyPlugin[] {
  const needed: LazyPlugin[] = [];
  if (FENCE.test(markdown)) needed.push("code");
  if (markdown.includes("$$")) needed.push("math");
  if (MERMAID_FENCE.test(markdown)) needed.push("mermaid");
  return needed;
}

function loadPlugin(name: LazyPlugin): Promise<void> {
  let pending = loading.get(name);
  if (!pending) {
    pending = loaders[name]()
      .then((plugin) => {
        (loaded as Record<LazyPlugin, unknown>)[name] = plugin;
      })
      .catch((error: unknown) => {
        // Rendering goes on without the plugin; a later render tries again.
        loading.delete(name);
        console.warn(`[streamdown] could not load the ${name} plugin`, error);
      });
    loading.set(name, pending);
  }
  return pending;
}

/**
 * Streamdown plugins for this markdown, loading any it needs that have not
 * arrived yet. `key` changes whenever a plugin arrives: Streamdown's blocks
 * re-render only when their text changes, not their plugins, so the caller
 * keys Streamdown on it to render the blocks again with the new plugin.
 */
export function useStreamdownPlugins(markdown: unknown): {
  plugins: PluginConfig;
  key: string;
} {
  const needed = useMemo(
    () => (typeof markdown === "string" ? pluginsNeededBy(markdown) : []),
    [markdown],
  );
  const missing = needed.filter((name) => !loaded[name]);
  const missingKey = missing.join(",");
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!missingKey) return;
    let active = true;
    void Promise.all(
      missingKey.split(",").map((name) => loadPlugin(name as LazyPlugin)),
    ).then(() => {
      if (active) setVersion((version) => version + 1);
    });
    return () => {
      active = false;
    };
  }, [missingKey]);

  const loadedKey = (["code", "math", "mermaid"] as const)
    .filter((name) => loaded[name])
    .join(",");
  // A new object only when the set of loaded plugins changes, so Streamdown does not re-parse.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plugins = useMemo(() => ({ ...loaded }), [loadedKey]);
  return { plugins, key: loadedKey || "base" };
}
