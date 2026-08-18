import assert from "node:assert/strict";
import { test } from "node:test";
import {
  videoPresentationGeneratedContentError,
  videoPresentationProviderError,
  videoPresentationSandboxError,
} from "../src/pipeline/errors";

test("generated-content failures use the existing stage retry budget", () => {
  const error = videoPresentationGeneratedContentError(
    "VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED",
    "Theme output was invalid.",
  );

  assert.equal(error.category, "validation");
  assert.equal(error.retryable, true);
});

test("provider and sandbox failures remain non-retryable", () => {
  const provider = videoPresentationProviderError(
    "VIDEO_PRESENTATION_THEME_ASSIGNMENT_FAILED",
    "Provider authentication failed.",
  );
  const sandbox = videoPresentationSandboxError(
    "VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE",
    "Sandbox is not configured.",
  );

  assert.equal(provider.category, "provider");
  assert.equal(provider.retryable, false);
  assert.equal(sandbox.category, "sandbox");
  assert.equal(sandbox.retryable, false);
});
