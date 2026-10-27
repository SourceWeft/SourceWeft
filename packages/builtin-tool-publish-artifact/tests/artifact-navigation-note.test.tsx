import assert from "node:assert/strict";
import { test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NavigationAttemptsNote } from "../src/ui/artifact-storage-ui";

test("the note is a calm informational line only when there were attempts", () => {
  assert.equal(renderToStaticMarkup(<NavigationAttemptsNote count={0} />), "");
  const many = renderToStaticMarkup(<NavigationAttemptsNote count={3} />);
  assert.match(
    many,
    /This version has tried to leave its page 3 times recently/,
  );
  assert.doesNotMatch(many, /role="alert"|destructive/);
  assert.match(
    renderToStaticMarkup(<NavigationAttemptsNote count={1} />),
    /1 time recently/,
  );
});

test("prompts render from a supplied text object and fall back to English", async () => {
  const { ExternalLinkPrompt, NavigatedAwayNotice } =
    await import("../src/ui/artifact-storage-ui");
  const { DEFAULT_ARTIFACT_STORAGE_TEXT, formatArtifactText } =
    await import("@sourceweft/contracts/artifact-storage-text");
  const custom = {
    ...DEFAULT_ARTIFACT_STORAGE_TEXT,
    navigatedAway: "XX-away",
    reloadPage: "XX-reload",
    navigationAttemptsOther: "XX-{count}-attempts",
    linkTitle: "XX-title",
  };
  const away = renderToStaticMarkup(
    <NavigatedAwayNotice onReload={() => undefined} text={custom} />,
  );
  assert.match(away, /XX-away/);
  assert.match(away, /XX-reload/);
  assert.match(
    renderToStaticMarkup(<NavigationAttemptsNote count={5} text={custom} />),
    /XX-5-attempts/,
  );
  const link = renderToStaticMarkup(
    <ExternalLinkPrompt
      url={new URL("https://example.com/")}
      onCancel={() => undefined}
      onContinue={() => undefined}
      text={custom}
    />,
  );
  assert.match(link, /XX-title/);
  // Without a text object the English defaults apply.
  assert.match(
    renderToStaticMarkup(<NavigatedAwayNotice onReload={() => undefined} />),
    /This page tried to go to another address/,
  );
  assert.equal(formatArtifactText("a {x} b {y}", { x: 1 }), "a 1 b {y}");
});
