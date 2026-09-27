// @vitest-environment jsdom
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import zhTWMessages from "@/messages/zh-TW.json";
import {
  button,
  click,
  mountWithIntl,
  unmountAll,
  withIntl,
} from "@/test/react";

import { McpReadmeCollapse } from "./mcp-readme-collapse";

afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function readme() {
  return (
    <div>
      <p>Intro</p>
      <a href="https://example.com/docs">Docs</a>
    </div>
  );
}

function region(scope: ParentNode = document) {
  return scope.querySelector<HTMLElement>("[data-state]")!;
}

describe("McpReadmeCollapse", () => {
  it("leaves a short README as it is", async () => {
    const { container } = await mountWithIntl(
      <McpReadmeCollapse collapsible={false}>{readme()}</McpReadmeCollapse>,
    );
    expect(container.innerHTML).toBe(
      '<div><p>Intro</p><a href="https://example.com/docs">Docs</a></div>',
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("folds a long README behind a control that unfolds and refolds it", async () => {
    await mountWithIntl(
      <McpReadmeCollapse collapsible>{readme()}</McpReadmeCollapse>,
    );
    const toggle = button("Show full README");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(region().id);
    expect(region().dataset.state).toBe("collapsed");
    expect(region().className).toContain("max-h-[75svh]");
    expect(region().className).toContain("overflow-hidden");
    // Folded text is clipped, not removed: it stays readable to assistive tech.
    expect(region().textContent).toContain("Docs");

    toggle.focus();
    await click(toggle);
    expect(region().dataset.state).toBe("expanded");
    expect(region().className).not.toContain("max-h-");
    // One control in both states, so it keeps the focus it was pressed with.
    expect(button("Show less")).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(toggle);

    await click(toggle);
    expect(region().dataset.state).toBe("collapsed");
    expect(button("Show full README")).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("unfolds when keyboard focus reaches a link inside the fold", async () => {
    await mountWithIntl(
      <McpReadmeCollapse collapsible>{readme()}</McpReadmeCollapse>,
    );
    const link = region().querySelector("a")!;
    await act(async () => link.focus());
    expect(region().dataset.state).toBe("expanded");
    expect(button("Show less").getAttribute("aria-expanded")).toBe("true");
  });

  it("stays folded when a pointer focuses a visible link", async () => {
    await mountWithIntl(
      <McpReadmeCollapse collapsible>{readme()}</McpReadmeCollapse>,
    );
    const link = region().querySelector("a")!;
    const matches = link.matches.bind(link);
    vi.spyOn(link, "matches").mockImplementation((selector) =>
      selector === ":focus-visible" ? false : matches(selector),
    );
    await act(async () => link.focus());
    expect(region().dataset.state).toBe("collapsed");
  });

  it("drops the control, without moving anything, when the README fits after all", async () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    await mountWithIntl(
      <McpReadmeCollapse collapsible>{readme()}</McpReadmeCollapse>,
    );
    const control = button("Show full README").parentElement!;
    // Out of the flow while folded: hiding it cannot shift what follows.
    expect(control.className).toContain("absolute");
    expect(region().className).toContain("mask-image");

    const box = region();
    let contentHeight = 400;
    Object.defineProperty(box, "scrollHeight", { get: () => contentHeight });
    Object.defineProperty(box, "clientHeight", { value: 400 });
    await act(async () => observers[0]!([], {} as ResizeObserver));
    expect(control.className).toContain("hidden");
    expect(region().className).not.toContain("mask-image");

    contentHeight = 900;
    await act(async () => observers[0]!([], {} as ResizeObserver));
    expect(control.className).not.toContain("hidden");
    expect(region().className).toContain("mask-image");
  });

  it("hydrates the folded first paint the server rendered, unchanged", async () => {
    const node = withIntl(
      <McpReadmeCollapse collapsible>{readme()}</McpReadmeCollapse>,
    );
    const html = renderToString(node);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("max-h-[75svh]");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const recoverable = vi.fn();
    const root = await act(async () =>
      hydrateRoot(container, node, { onRecoverableError: recoverable }),
    );
    expect(recoverable).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe(html);
    await act(async () => root.unmount());
  });

  it("speaks the visitor's language", async () => {
    await mountWithIntl(
      <McpReadmeCollapse collapsible>{readme()}</McpReadmeCollapse>,
      { locale: "zh-TW", messages: zhTWMessages },
    );
    const toggle = button("展開完整 README");
    await click(toggle);
    expect(toggle.textContent).toBe("收起");
  });
});
