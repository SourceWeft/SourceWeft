import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelGatewayError,
  TTS_UNSUPPORTED_VOICE_REASON,
} from "@sourceweft/model-gateway";
import { unsupportedVoiceFailure } from "../src/agent/narration-tool";

test("an unsupported voice becomes a failure that names the available voices", () => {
  const message =
    "Voice 'neutral, clear, calm' is not available for XiaomiMiMo/MiMo-V2.5-tts. Available voices: mimo_default, Mia. Leave the voice out to use the default.";

  const failure = unsupportedVoiceFailure(
    new ModelGatewayError({
      code: "BAD_REQUEST",
      message,
      retryable: false,
      metadata: { reason: TTS_UNSUPPORTED_VOICE_REASON },
    }),
  );

  assert.deepEqual(failure, {
    status: "failed",
    code: "VIDEO_NARRATION_VOICE_UNSUPPORTED",
    message,
  });
});

test("other provider errors are left to the general handling", () => {
  assert.equal(
    unsupportedVoiceFailure(
      new ModelGatewayError({ code: "BAD_REQUEST", message: "text too long" }),
    ),
    null,
  );
  assert.equal(
    unsupportedVoiceFailure(
      new ModelGatewayError({ code: "UPSTREAM", message: "boom" }),
    ),
    null,
  );
  assert.equal(unsupportedVoiceFailure(new Error("network")), null);
});
