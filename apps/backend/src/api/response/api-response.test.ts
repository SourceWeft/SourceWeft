import assert from "node:assert/strict";
import { test } from "vitest";
import { ContentError } from "../../modules/content/errors";
import { toApiError } from "./api-response";

test("a content error's details reach the client only when marked public", () => {
  const internal = toApiError(
    new ContentError(502, "MODEL_UPSTREAM_ERROR", "failed", {
      details: { provider: "openrouter", requestId: "req-1" },
    }),
  );
  assert.equal(internal.code, "MODEL_UPSTREAM_ERROR");
  assert.equal(internal.details, undefined);

  const exposed = toApiError(
    new ContentError(422, "YOUTUBE_COLLECTION_URL", "pick videos", {
      details: { kind: "playlist" },
      exposeDetails: true,
    }),
  );
  assert.equal(exposed.statusCode, 422);
  assert.equal(exposed.code, "YOUTUBE_COLLECTION_URL");
  assert.deepEqual(exposed.details, { kind: "playlist" });
});
