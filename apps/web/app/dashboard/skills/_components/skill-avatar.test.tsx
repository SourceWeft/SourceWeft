// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { SkillAvatar } from "./skill-avatar";
import messages from "../../../../messages/en.json";

// SkillAvatar reads its aria/title labels through next-intl; supply the shell
// catalog so the rendered accessibility text matches the English source.
const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];
function withIntl(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={intlMessages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  );
}

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});
test("publisher attribution, image failure and version changes are visible and recoverable", () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const item = {
    displayName: "Report Writer",
    slug: "writer",
    sourceType: "registry_github",
    logo: {
      url: "https://github.com/acme.png?size=128",
      source: "publisher" as const,
    },
  };
  act(() => root.render(withIntl(<SkillAvatar item={item} />)));
  const image = container.querySelector("img")!;
  expect(image.alt).toContain("publisher avatar");
  expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
  act(() => image.dispatchEvent(new Event("error")));
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe("RW");
  expect(container.querySelector("[title]")?.getAttribute("title")).toContain(
    "Logo unavailable",
  );
  act(() =>
    root.render(
      withIntl(
        <SkillAvatar
          item={{
            ...item,
            logo: {
              url: "https://example.com/new-version.png",
              source: "skill",
            },
          }}
        />,
      ),
    ),
  );
  expect(container.querySelector("img")?.src).toBe(
    "https://example.com/new-version.png",
  );
});
test("builtins use capability icons and custom skills have name-based placeholders", () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      withIntl(
        <SkillAvatar
          item={{
            displayName: "Feynman",
            slug: "feynman",
            sourceType: "builtin",
          }}
        />,
      ),
    ),
  );
  expect(container.querySelector("svg")).not.toBeNull();
  act(() =>
    root.render(
      withIntl(
        <SkillAvatar
          item={{
            displayName: "Team Writer",
            slug: "writer",
            sourceType: "workspace_custom",
          }}
        />,
      ),
    ),
  );
  expect(container.textContent).toBe("TW");
});
