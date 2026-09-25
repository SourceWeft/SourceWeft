// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ desktop: false }));
vi.mock("../../../lib/desktop-bridge", () => ({
  desktopBridge: { isAvailable: () => native.desktop },
}));
import { DashboardSidebarBrand } from "./dashboard-sidebar-brand";
import { mount, unmountAll } from "@/test/react";

afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
});

it.each([480, 1440])(
  "shows the brand in a %i px browser but not in the PC client",
  async (width) => {
    vi.stubGlobal("innerWidth", width);
    native.desktop = false;
    const view = await mount(createElement(DashboardSidebarBrand));
    const { container } = view;
    expect(container.textContent).toBe("SourceWeft");
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/dashboard",
    );
    native.desktop = true;
    await view.render(createElement(DashboardSidebarBrand));
    expect(container.querySelector("a")).toBeNull();
  },
);

it("keeps only an accessible logo in the collapsed Web rail", async () => {
  native.desktop = false;
  const { container } = await mount(
    createElement(DashboardSidebarBrand, { collapsed: true }),
  );
  expect(container.textContent).toBe("");
  expect(container.querySelector("img")).not.toBeNull();
  expect(container.querySelector("a")?.getAttribute("aria-label")).toBe(
    "SourceWeft",
  );
});
