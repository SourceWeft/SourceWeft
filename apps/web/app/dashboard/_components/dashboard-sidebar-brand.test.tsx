// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ desktop: false }));
vi.mock("../../../lib/desktop-bridge", () => ({
  desktopBridge: { isAvailable: () => native.desktop },
}));
import { DashboardSidebarBrand } from "./dashboard-sidebar-brand";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([480, 1440])(
  "shows the brand in a %i px browser but not in the PC client",
  async (width) => {
    vi.stubGlobal("innerWidth", width);
    native.desktop = false;
    await act(async () => root.render(createElement(DashboardSidebarBrand)));
    expect(container.textContent).toBe("SourceWeft");
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/dashboard",
    );
    native.desktop = true;
    await act(async () => root.render(createElement(DashboardSidebarBrand)));
    expect(container.querySelector("a")).toBeNull();
  },
);

it("keeps only an accessible logo in the collapsed Web rail", async () => {
  native.desktop = false;
  await act(async () =>
    root.render(createElement(DashboardSidebarBrand, { collapsed: true })),
  );
  expect(container.textContent).toBe("");
  expect(container.querySelector("img")).not.toBeNull();
  expect(container.querySelector("a")?.getAttribute("aria-label")).toBe(
    "SourceWeft",
  );
});
