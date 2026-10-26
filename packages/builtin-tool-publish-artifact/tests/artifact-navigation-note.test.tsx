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
