#!/usr/bin/env node
// Generates the fake microphone's audio fixture for e2e/dictation.spec.ts.
//
// Produces a 16 kHz mono PCM WAV: 1 s silence, then three 2 s tone bursts at
// -15 dBFS separated by 1.2 s silence, then 2 s silence at the end. Fed
// through the speech segmenter (packages/ui/src/lib/audio/speech-segmenter.ts)
// at 20 ms frames, this must cut into exactly three segments, each 2-3 s:
// the bursts are far louder than the -45 dBFS / 12 dB-above-floor speech
// threshold, and the 1.2 s silent gaps comfortably clear the 600 ms of
// silence that ends an open segment.
//
// The output is not committed; run this before the Playwright spec, which
// fails with a clear message if the file is missing.
import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 16000;
const TONE_HZ = 300;
// Peak amplitude for a -15 dBFS sine, relative to full scale for Int16 samples.
const PEAK = Math.round(32767 * 10 ** (-15 / 20));

// apps/web/e2e/fixtures/make-dictation-audio.mjs -> repository root.
const OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../output/playwright/dictation/three-bursts.wav",
);

function silence(seconds) {
  return new Int16Array(Math.round(SAMPLE_RATE * seconds));
}

function tone(seconds) {
  const samples = new Int16Array(Math.round(SAMPLE_RATE * seconds));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(
      PEAK * Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE),
    );
  }
  return samples;
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const samples = concat([
  silence(1),
  tone(2),
  silence(1.2),
  tone(2),
  silence(1.2),
  tone(2),
  silence(2),
]);

function writeWav(path, pcm) {
  const dataBytes = pcm.length * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate (mono, 16-bit)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);

  const body = Buffer.alloc(dataBytes);
  for (let i = 0; i < pcm.length; i++) body.writeInt16LE(pcm[i], i * 2);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([header, body]));
}

writeWav(OUTPUT_PATH, samples);

const durationSec = samples.length / SAMPLE_RATE;
console.log(
  `Wrote ${OUTPUT_PATH} (${samples.length} samples, ${durationSec.toFixed(2)}s, 16 kHz mono PCM, peak ${PEAK}).`,
);
