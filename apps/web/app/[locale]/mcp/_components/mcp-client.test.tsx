// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { click, flush, mount, unmountAll } from "@/test/react";

import { CopyButton, McpIcon } from "./mcp-client";

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("copies the value, says so in the caller's words, and reports it", async () => {
  const onCopied = vi.fn();
  const { container } = await mount(
    <CopyButton
      copiedLabel="已复制"
      failedLabel="复制失败"
      label="复制"
      onCopied={onCopied}
      value="[![Listed on SourceWeft](x)](y)"
    />,
  );
  const button = container.querySelector("button")!;
  expect(button.textContent).toBe("复制");

  await click(button);
  await flush();

  expect(writeText).toHaveBeenCalledWith("[![Listed on SourceWeft](x)](y)");
  expect(onCopied).toHaveBeenCalledTimes(1);
  expect(button.textContent).toBe("已复制");
});

async function mountFailing() {
  const onCopied = vi.fn();
  const { container } = await mount(
    <CopyButton
      copiedLabel="已复制"
      failedLabel="复制失败"
      label="复制"
      onCopied={onCopied}
      value="x"
    />,
  );
  return { button: container.querySelector("button")!, onCopied };
}

test("says the copy failed, in the caller's words, when the clipboard refuses", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  const { button, onCopied } = await mountFailing();

  await click(button);
  await flush(2);

  expect(writeText).toHaveBeenCalledWith("x");
  expect(onCopied).not.toHaveBeenCalled();
  expect(button.textContent).toBe("复制失败");
});

test("says the copy failed on a page with no clipboard (plain http), then offers it again", async () => {
  // Browsers leave `navigator.clipboard` undefined outside a secure context.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  vi.useFakeTimers();
  const { button, onCopied } = await mountFailing();

  await click(button);
  await flush(2);

  expect(onCopied).not.toHaveBeenCalled();
  expect(button.textContent).toBe("复制失败");

  await act(async () => vi.advanceTimersByTime(1600));
  expect(button.textContent).toBe("复制");
});

test("McpIcon shows the name's monogram when there is no icon, and never a broken image", async () => {
  const none = await mount(<McpIcon name="Notion" trusted />);
  expect(none.container.querySelector("img")).toBeNull();
  expect(
    none.container.querySelector("[data-mcp-icon-monogram]")?.textContent,
  ).toBe("N");

  // An icon labelled as a GitHub avatar but served from elsewhere is not rendered.
  const untrusted = await mount(
    <McpIcon
      iconSource="github-avatar"
      iconUrl="https://evil.test/acme.png"
      name="Acme"
      trusted={false}
    />,
  );
  expect(untrusted.container.querySelector("img")).toBeNull();
  expect(
    untrusted.container.querySelector("[data-mcp-icon-monogram]")?.textContent,
  ).toBe("A");

  // Without a name the generic MCP glyph stands in.
  const glyph = await mount(<McpIcon trusted />);
  expect(glyph.container.querySelector("[data-mcp-icon-monogram]")).toBeNull();
  expect(glyph.container.querySelector("svg")).not.toBeNull();
});

/** Make every image report this load state, as a browser would. */
function stubImages({
  complete = false,
  width = 0,
}: {
  complete?: boolean;
  width?: number;
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
      width > 0 ? Promise.resolve() : Promise.reject(new Error("broken")),
  });
}

test("McpIcon keeps the monogram under a trusted-host avatar until it loads, and shows it alone when it fails", async () => {
  stubImages({});
  const { container } = await mount(
    <McpIcon
      iconSource="github-avatar"
      iconUrl="https://github.com/acme.png?size=128"
      name="Acme"
      trusted
    />,
  );
  const img = container.querySelector("img");
  expect(img?.getAttribute("src")).toBe("https://github.com/acme.png?size=128");
  // Still loading: the placeholder is there so the tile is never empty.
  expect(container.querySelector("[data-mcp-icon-monogram]")?.textContent).toBe(
    "A",
  );

  await act(async () => {
    img!.dispatchEvent(new Event("error"));
  });
  await flush();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("[data-mcp-icon-monogram]")?.textContent).toBe(
    "A",
  );
  Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
});

test("McpIcon shows a loaded logo on white, the monogram gone", async () => {
  stubImages({});
  const { container } = await mount(
    <McpIcon
      iconSource="favicon"
      iconUrl="https://assets.sourceweft.com/market/mcp-icons/notion.com/a.png"
      name="Notion"
      trusted
    />,
  );
  const img = container.querySelector("img")!;
  expect(img.getAttribute("src")).toBe(
    "https://assets.sourceweft.com/market/mcp-icons/notion.com/a.png",
  );
  await act(async () => {
    img.dispatchEvent(new Event("load"));
  });
  await flush();
  expect(container.querySelector("[data-mcp-icon-monogram]")).toBeNull();
  expect(container.querySelector("img")).not.toBeNull();
  expect(container.firstElementChild?.className).toContain("bg-white");
  Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
});

test("McpIcon settles an image that was already broken before hydration", async () => {
  // A server-rendered <img> can fail before React attaches onError; the ref
  // then decodes it to tell a broken image from a loaded one.
  stubImages({ complete: true, width: 0 });
  const { container } = await mount(
    <McpIcon
      iconSource="github-avatar"
      iconUrl="https://github.com/nobody-here.png?size=128"
      name="Nobody"
      trusted={false}
    />,
  );
  await flush();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("[data-mcp-icon-monogram]")?.textContent).toBe(
    "N",
  );
  Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
});
