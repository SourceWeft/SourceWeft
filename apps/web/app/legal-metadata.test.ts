import { describe, expect, it } from "vitest";

import { metadata as privacy } from "./privacy/page";
import { metadata as terms } from "./terms/page";

// The root layout's title template appends " | SourceWeft". These pages name
// the site themselves, so they must opt out of the template or the document
// title ends in "| SourceWeft | SourceWeft".
describe.each([
  ["terms", terms],
  ["privacy", privacy],
])("%s page metadata", (_, metadata) => {
  it("names the site exactly once in the document title", () => {
    expect(metadata.title).toEqual({ absolute: expect.any(String) });
    const absolute = (metadata.title as { absolute: string }).absolute;
    expect(absolute.match(/\| SourceWeft/g)).toHaveLength(1);
    expect(absolute.endsWith(" | SourceWeft")).toBe(true);
  });

  it("keeps the OpenGraph and Twitter titles, which no template touches", () => {
    const absolute = (metadata.title as { absolute: string }).absolute;
    expect(metadata.openGraph?.title).toBe(absolute);
    expect(metadata.twitter?.title).toBe(absolute);
  });
});
