import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { ArtifactPipeline } from "./artifact-pipeline";

test("failed pipeline opens the failed step with code and attempt", () => {
  const html = renderToStaticMarkup(
    <ArtifactPipeline
      errorCode="VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED"
      errorMessage="VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED: Theme provider returned invalid structured content."
      footerRight="1m 42s · 3 / 11 · attempt 2/2"
      status="failed"
      steps={[
        {
          id: "planning_storyboard",
          label: "Planning storyboard",
          status: "completed",
          summary: "Planned 8 slides",
        },
        {
          id: "assigning_slide_themes",
          label: "Assigning slide themes",
          status: "failed",
          attempt: 2,
          maxAttempts: 2,
          errorMessage:
            "VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED: Theme provider returned invalid structured content.",
          logTail: ["validation failed after repair"],
        },
      ]}
      title="Video presentation failed · Assigning slide themes"
    />,
  );

  assert.match(html, /Video presentation failed · Assigning slide themes/);
  assert.match(html, /attempt 2\/2/);
  assert.match(html, /Theme provider returned invalid structured content/);
  assert.match(html, /VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED/);
  assert.match(html, /validation failed after repair/);
  assert.equal(
    html.match(/Theme provider returned invalid structured content/g)?.length,
    1,
  );
  assert.equal(html.match(/VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED/g)?.length, 1);
});
