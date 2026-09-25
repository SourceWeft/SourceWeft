// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DesktopWindowChrome } from "./desktop-window-chrome";
import { mount, unmountAll } from "@/test/react";

const { invoke, errorToast } = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  errorToast: vi.fn(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard/chat" }));
vi.mock("sonner", () => ({ toast: { error: errorToast } }));

let container: HTMLDivElement;
beforeEach(() => {
  window.__SOURCEWEFT_DESKTOP__ = {
    isDesktop: true,
    invoke,
    listen: vi.fn(),
  };
  window.__SOURCEWEFT_TITLEBAR_OVERLAY__ = true;
  vi.clearAllMocks();
});
afterEach(async () => {
  await unmountAll();
  delete window.__SOURCEWEFT_DESKTOP__;
  delete window.__SOURCEWEFT_TITLEBAR_OVERLAY__;
});

async function render() {
  ({ container } = await mount(
    <>
      <DesktopWindowChrome />
      <header data-desktop-drag-region>
        <h1>Conversation</h1>
        <button>
          <svg>
            <path />
          </svg>
        </button>
        <a href="#">Link</a>
        <input />
        <div contentEditable suppressContentEditableWarning>
          Draft
        </div>
        <div role="combobox">
          <span>Model</span>
        </div>
        <div data-desktop-no-drag>
          <span>Custom control</span>
        </div>
      </header>
      <main>Messages</main>
    </>,
  ));
}
async function press(selector: string, options: MouseEventInit = {}) {
  await act(async () => {
    container.querySelector(selector)!.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        detail: 1,
        ...options,
      }),
    );
  });
}

test("titlebar blanks drag and a second press maximizes using the scoped native command", async () => {
  await render();
  await press("header");
  expect(invoke).toHaveBeenLastCalledWith("desktop_titlebar_action", {
    action: "drag",
  });
  await press("h1", { detail: 2 });
  expect(invoke).toHaveBeenLastCalledWith("desktop_titlebar_action", {
    action: "toggleMaximize",
  });
});

test("nested controls, editable content, right clicks and body content never drag", async () => {
  await render();
  for (const target of [
    "path",
    "a",
    "input",
    "[contenteditable]",
    "[role=combobox] span",
    "[data-desktop-no-drag] span",
    "main",
  ]) {
    await press(target);
  }
  await press("header", { button: 2 });
  expect(invoke).not.toHaveBeenCalled();
});

test("ordinary browsers and native windows without overlay never install dragging", async () => {
  delete window.__SOURCEWEFT_TITLEBAR_OVERLAY__;
  await render();
  await press("header");
  expect(invoke).not.toHaveBeenCalled();
});

test("native drag errors remain visible instead of silently losing the action", async () => {
  invoke.mockRejectedValueOnce("DESKTOP_ACCESS_DENIED");
  await render();
  await press("header");
  expect(errorToast).toHaveBeenCalledWith("DESKTOP_ACCESS_DENIED");
});
