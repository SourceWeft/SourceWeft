import assert from "node:assert/strict";
import { test } from "vitest";

import { probeAudioDurationSeconds } from "./audio-duration";

function buildWavBuffer(input: { sampleRate: number; seconds: number }) {
  const sampleCount = Math.round(input.sampleRate * input.seconds);
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(input.sampleRate, 24);
  buffer.writeUInt32LE(input.sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function buildMp3Buffer(input: { frames: number }) {
  // MPEG-1 Layer III, 128kbps, 44.1kHz, no padding, stereo.
  // Frame size = 144 * 128000 / 44100 = 417 bytes; 1152 samples per frame.
  const frameSize = 417;
  const frame = Buffer.alloc(frameSize);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  return Buffer.concat(Array.from({ length: input.frames }, () => frame));
}

test("measures WAV duration exactly from the header", async () => {
  const buffer = buildWavBuffer({ sampleRate: 16_000, seconds: 2.5 });
  const duration = await probeAudioDurationSeconds({
    buffer,
    mimeType: "audio/wav",
  });
  assert.equal(duration, 2.5);
});

test("measures WAV by magic bytes even when the mime hint is wrong", async () => {
  // TTS providers may return WAV despite an mp3 responseFormat/Content-Type.
  const buffer = buildWavBuffer({ sampleRate: 16_000, seconds: 3 });
  const duration = await probeAudioDurationSeconds({
    buffer,
    mimeType: "audio/mpeg",
  });
  assert.equal(duration, 3);
});

test("streamed WAV with a placeholder data size measures from actual bytes", async () => {
  const buffer = buildWavBuffer({ sampleRate: 16_000, seconds: 5 });
  // Streaming writers leave a tiny/placeholder data-chunk size they never
  // seek back to fix; the real audio bytes follow anyway.
  buffer.writeUInt32LE(640, 40); // declares 0.02s of data
  const duration = await probeAudioDurationSeconds({
    buffer,
    mimeType: "audio/wav",
  });
  assert.equal(duration, 5);
});

test("measures MP3 duration by scanning frames", async () => {
  // 40 frames * 1152 samples / 44100 Hz ≈ 1.04s
  const buffer = buildMp3Buffer({ frames: 40 });
  const duration = await probeAudioDurationSeconds({
    buffer,
    mimeType: "audio/mpeg",
  });
  assert.ok(duration !== null, "expected mp3 probe to succeed");
  assert.ok(
    Math.abs(duration - 1.04) < 0.15,
    `expected ~1.04s, got ${duration}`,
  );
});

test("returns null for unparseable input", async () => {
  const duration = await probeAudioDurationSeconds({
    buffer: Buffer.from("real-audio-bytes"),
    mimeType: "audio/mpeg",
  });
  assert.equal(duration, null);
});
