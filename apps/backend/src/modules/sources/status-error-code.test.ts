import assert from "node:assert/strict";
import { test } from "vitest";
import { BillingError } from "@sourceweft/contracts/billing-runtime";
import { ContentError } from "../content/errors";
import { buildSourceParseFailureError } from "./parse-diagnostics";
import { deriveStatusDetail } from "./status-detail";

const source = {
  sourceType: "web_url",
  ingestKind: "web_url",
  mimeType: null,
  externalUri: "https://example.com/a",
  storageBucket: null,
  storageKey: null,
  metadata: {},
  status: "failed",
  estimatedPages: null,
  error: {},
} as never;

test("a billing refusal keeps its code so the UI can tell out-of-pages from unreadable", () => {
  const failure = buildSourceParseFailureError({
    source,
    error: new BillingError(
      "PAGES_LIMIT_EXCEEDED",
      402,
      "Ingestion pages limit exceeded",
    ),
  });
  assert.equal(failure.code, "PAGES_LIMIT_EXCEEDED");
});

test("a content error keeps its code and a plain error has none", () => {
  assert.equal(
    buildSourceParseFailureError({
      source,
      error: new ContentError(422, "WEB_SOURCE_YOUTUBE_UNSUPPORTED", "no"),
    }).code,
    "WEB_SOURCE_YOUTUBE_UNSUPPORTED",
  );
  assert.equal(
    buildSourceParseFailureError({ source, error: new Error("boom") }).code,
    undefined,
  );
});

test("the status detail exposes the failure's code", () => {
  const detail = deriveStatusDetail({
    ...(source as object),
    error: {
      message: "Ingestion pages limit exceeded",
      code: "PAGES_LIMIT_EXCEEDED",
    },
  } as never);
  assert.equal(detail.errorCode, "PAGES_LIMIT_EXCEEDED");
  assert.equal(detail.error, "Ingestion pages limit exceeded");
  assert.equal(deriveStatusDetail(source).errorCode, null);
});
