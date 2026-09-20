import assert from "node:assert/strict";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { ArtifactPipeline } from "./artifact-pipeline";
import messages from "../../../../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];

test("failed pipeline opens the failed step and de-duplicates its error", () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={intlMessages}>
      <ArtifactPipeline
      errorCode="REPORT_BUILD_FAILED"
      errorMessage="REPORT_BUILD_FAILED: Report provider returned invalid structured content."
      footerRight="1m 42s · 2 / 4"
      status="failed"
      steps={[
        {
          id: "planning",
          label: "Planning report",
          status: "completed",
          summary: "Planned 8 sections",
        },
        {
          id: "building",
          label: "Building report",
          status: "failed",
          errorMessage:
            "REPORT_BUILD_FAILED: Report provider returned invalid structured content.",
          logTail: ["validation failed"],
        },
      ]}
      title="Report failed · Building report"
      />
    </NextIntlClientProvider>,
  );

  assert.match(html, /Report failed · Building report/);
  assert.match(html, /Report provider returned invalid structured content/);
  assert.match(html, /REPORT_BUILD_FAILED/);
  assert.match(html, /validation failed/);
  assert.equal(
    html.match(/Report provider returned invalid structured content/g)?.length,
    1,
  );
  assert.equal(html.match(/REPORT_BUILD_FAILED/g)?.length, 1);
});
