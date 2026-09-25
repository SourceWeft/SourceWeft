// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test } from "vitest";
import { SkillAvatar } from "./skill-avatar";
import { mountWithIntl, unmountAll, withIntl } from "@/test/react";

// SkillAvatar reads its aria/title labels through next-intl; supply the shell
// catalog so the rendered accessibility text matches the English source.
const intl = { timeZone: "UTC" };

afterEach(unmountAll);
test("publisher attribution, image failure and version changes are visible and recoverable", async () => {
  const item = {
    displayName: "Report Writer",
    slug: "writer",
    sourceType: "registry_github",
    logo: {
      url: "https://github.com/acme.png?size=128",
      source: "publisher" as const,
    },
  };
  const view = await mountWithIntl(<SkillAvatar item={item} />, intl);
  const { container } = view;
  const image = container.querySelector("img")!;
  expect(image.alt).toContain("publisher avatar");
  expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
  act(() => image.dispatchEvent(new Event("error")));
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe("RW");
  expect(container.querySelector("[title]")?.getAttribute("title")).toContain(
    "Logo unavailable",
  );
  await view.render(
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
      intl,
    ),
  );
  expect(container.querySelector("img")?.src).toBe(
    "https://example.com/new-version.png",
  );
});
test("builtins use capability icons and custom skills have name-based placeholders", async () => {
  const view = await mountWithIntl(
    <SkillAvatar
      item={{
        displayName: "Feynman",
        slug: "feynman",
        sourceType: "builtin",
      }}
    />,
    intl,
  );
  const { container } = view;
  expect(container.querySelector("svg")).not.toBeNull();
  await view.render(
    withIntl(
      <SkillAvatar
        item={{
          displayName: "Team Writer",
          slug: "writer",
          sourceType: "workspace_custom",
        }}
      />,
      intl,
    ),
  );
  expect(container.textContent).toBe("TW");
});
