import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createS3ObjectStore,
  signedWriteExpiry,
} from "../src/store/object-store";
const store = () =>
  createS3ObjectStore({
    bucket: "isolated-fixture",
    region: "auto",
    endpoint: "https://objects.invalid",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture-secret" },
  });
test("SDK write-once grant carries its actual SigV4 expiry and leaves legacy signing compatible", async () => {
  const s3 = store();
  const grant = await s3.presignWriteOnceGrant!("owned/pack", 73);
  const url = new URL(grant.url);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "73");
  assert.ok(
    url.searchParams
      .get("X-Amz-SignedHeaders")!
      .split(";")
      .includes("if-none-match"),
  );
  assert.equal(
    grant.expiresAt.getTime(),
    signedWriteExpiry(grant.url).getTime(),
  );
  assert.equal(
    typeof (await s3.presignWriteOnce("owned/legacy", 73)),
    "string",
  );
});
test("expiry parser rejects ambiguous, malformed, nonfinite and noncanonical signed metadata", () => {
  const valid =
    "https://objects.invalid/pack?X-Amz-Date=20261009T120000Z&X-Amz-Expires=60";
  assert.equal(
    signedWriteExpiry(valid).toISOString(),
    "2026-10-09T12:01:00.000Z",
  );
  for (const value of [
    valid + "&X-Amz-Date=20261009T130000Z",
    valid + "&x-amz-expires=30",
    valid.replace("20261009", "20260230"),
    valid.replace("120000Z", "250000Z"),
    valid.replace("Expires=60", "Expires=0"),
    valid.replace("Expires=60", "Expires=Infinity"),
    valid.replace("Expires=60", "Expires=604801"),
    valid.replace("Expires=60", "Expires=1.5"),
    valid.replace("Expires=60", "Expires=01"),
    valid.replace("X-Amz-Date=20261009T120000Z&", ""),
    valid.replace("https:", "file:"),
  ])
    assert.throws(() => signedWriteExpiry(value));
});
test("clock rollback does not rewrite the absolute expiry encoded in an earlier grant", () => {
  const earlier = signedWriteExpiry(
    "https://objects.invalid/p?X-Amz-Date=20261009T130000Z&X-Amz-Expires=3600",
  );
  const later = signedWriteExpiry(
    "https://objects.invalid/p?X-Amz-Date=20261009T120000Z&X-Amz-Expires=3600",
  );
  assert.equal(
    Math.max(earlier.getTime(), later.getTime()),
    Date.parse("2026-10-09T14:00:00Z"),
  );
});
