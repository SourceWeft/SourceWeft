import { describe, expect, it } from "vitest";
import { asrChargeIdempotencyKey } from "./asr-charge-key";

describe("asrChargeIdempotencyKey", () => {
  const file = { fileName: "talk.mp3", fileSize: 6_181_241 };

  it("never reuses the parse job key, which the page charge owns", () => {
    const parseKey = "source_parse_a5922a76_1";

    const key = asrChargeIdempotencyKey({
      ...file,
      sourceId: "a5922a76",
      idempotencyKey: parseKey,
    });

    expect(key).not.toBe(parseKey);
    expect(key).toBe("source_parse_a5922a76_1:asr");
  });

  it("is stable across retries of the same parse job", () => {
    const input = { ...file, idempotencyKey: " source_parse_a_2 " };

    expect(asrChargeIdempotencyKey(input)).toBe(asrChargeIdempotencyKey(input));
    expect(asrChargeIdempotencyKey(input)).toBe("source_parse_a_2:asr");
  });

  it("keeps the established key when no parse job key is given", () => {
    expect(asrChargeIdempotencyKey({ ...file, sourceId: "a5922a76" })).toBe(
      "source-asr:a5922a76:6181241:credits",
    );
    expect(asrChargeIdempotencyKey({ ...file, idempotencyKey: "  " })).toBe(
      "source-asr:talk.mp3:6181241:credits",
    );
  });
});
