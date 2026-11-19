import { expect, test } from "vitest";
import { composerTextToPrompt } from "./composer-schedule-button";

test("sources become @mentions and commands vanish", () => {
  expect(
    composerTextToPrompt(
      "[skills:ppt-deck](PPT deck) Summarize [source:src_1](Q3 report) weekly",
    ),
  ).toBe("Summarize @Q3 report weekly");
});

test("escaped characters in a label come back", () => {
  expect(composerTextToPrompt("[source:s](Plan (v2\\)) now")).toBe(
    "@Plan (v2) now",
  );
});

test("plain text is unchanged", () => {
  expect(composerTextToPrompt("  Check the news  ")).toBe("Check the news");
});
