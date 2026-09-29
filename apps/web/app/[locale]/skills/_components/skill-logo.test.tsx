// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { flush, mount, unmountAll } from "@/test/react";
import { SkillTile } from "./skill-logo";

const AVATAR = "https://github.com/anthropics.png?size=128";
// Shape only: jsdom never decodes it, the canvas below is stubbed.
const THUMBNAIL = "data:image/png;base64,iVBORw0KGgo=";

const hydrated: { root: Root; container: HTMLElement }[] = [];

afterEach(async () => {
  await unmountAll();
  for (const { root, container } of hydrated.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
});

/** Make every image report this load state, as a browser would. */
function stubImages({
  complete = false,
  width = 0,
  decodes = width > 0,
}: {
  complete?: boolean;
  width?: number;
  decodes?: boolean;
}) {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    complete,
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    width,
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
    width,
  );
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: () =>
      decodes ? Promise.resolve() : Promise.reject(new Error("broken")),
  });
}

/** Server-render the tile, then hydrate it the way the page does. */
async function hydrate(node: ReactElement) {
  const container = document.createElement("div");
  container.innerHTML = renderToString(node);
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = hydrateRoot(container, node);
  });
  hydrated.push({ root, container });
  return container;
}

const tile = (container: HTMLElement) =>
  container.firstElementChild as HTMLElement;

describe("SkillTile", () => {
  it("server-renders the generic tile underneath the logo, never an empty box", () => {
    const html = renderToString(
      <SkillTile logo={{ url: AVATAR, source: "publisher" }} verified />,
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(AVATAR);
    expect(tile(container).className).toContain("bg-zinc-950");
  });

  it("shows the logo on white once it loads, and the generic tile if it fails", async () => {
    stubImages({ width: 128 });
    const loads = await mount(
      <SkillTile logo={{ url: AVATAR, source: "publisher" }} verified />,
    );
    const image = loads.container.querySelector("img")!;
    expect(loads.container.querySelector("svg")).not.toBeNull();
    act(() => image.dispatchEvent(new Event("load")));
    expect(loads.container.querySelector("svg")).toBeNull();
    expect(tile(loads.container).className).toContain("bg-white");

    const fails = await mount(
      <SkillTile
        logo={{ url: "https://example.com/gone.png", source: "skill" }}
        verified={false}
      />,
    );
    act(() =>
      fails.container.querySelector("img")!.dispatchEvent(new Event("error")),
    );
    expect(fails.container.querySelector("img")).toBeNull();
    expect(fails.container.querySelector("svg")).not.toBeNull();
    expect(tile(fails.container).className).toContain("bg-zinc-200");
  });

  it("settles a logo that failed before hydration attached onError", async () => {
    stubImages({ complete: true, width: 0 });
    const container = await hydrate(
      <SkillTile logo={{ url: AVATAR, source: "publisher" }} verified />,
    );
    await flush(2);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("settles a logo that loaded before hydration attached onLoad", async () => {
    stubImages({ complete: true, width: 128 });
    const container = await hydrate(
      <SkillTile logo={{ url: AVATAR, source: "publisher" }} verified />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(AVATAR);
    expect(container.querySelector("svg")).toBeNull();
    expect(tile(container).className).toContain("bg-white");
  });

  it("puts a transparent thumbnail with light artwork on a dark backdrop", async () => {
    stubImages({ complete: true, width: 2 });
    // Two white pixels, two transparent ones.
    const data = Uint8ClampedArray.from([
      255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => undefined,
      getImageData: () => ({ data }),
    } as unknown as CanvasRenderingContext2D);
    const { container } = await mount(
      <SkillTile logo={{ url: THUMBNAIL, source: "skill" }} verified={false} />,
    );
    expect(tile(container).className).toContain("bg-zinc-900");
    expect(tile(container).className).not.toContain("bg-white");
  });

  it("never reads remote logos back through a canvas", async () => {
    stubImages({ complete: true, width: 128 });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    const { container } = await mount(
      <SkillTile logo={{ url: AVATAR, source: "publisher" }} verified />,
    );
    expect(getContext).not.toHaveBeenCalled();
    expect(tile(container).className).toContain("bg-white");
  });
});
