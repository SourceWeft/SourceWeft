import { describe, expect, test } from "vitest";
import { DICTATION_ERROR_CODES } from "@sourceweft/contracts/dictation";
import { ContentError } from "../content/errors";
import { readDictationWav } from "./wav";

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const PCM_FORMAT = 1;
const CHUNK_HEADER_BYTES = 8;

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    bytes[offset + i] = value.charCodeAt(i);
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

type BuildOptions = {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  audioFormat?: number;
  numSamples?: number;
  /** When set, overrides the `data` chunk's declared size, independent of the bytes actually written. */
  declaredDataSize?: number;
  extraChunk?: { id: string; data: Uint8Array };
};

/** Builds a WAV file byte-for-byte, so tests can construct both valid files and specific violations. */
function buildWav(options: BuildOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const channels = options.channels ?? CHANNELS;
  const bitsPerSample = options.bitsPerSample ?? BITS_PER_SAMPLE;
  const audioFormat = options.audioFormat ?? PCM_FORMAT;
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = options.numSamples ?? 0;
  const actualDataSize = numSamples * channels * bytesPerSample;
  const declaredDataSize = options.declaredDataSize ?? actualDataSize;

  const fmtChunk = new Uint8Array(CHUNK_HEADER_BYTES + 16);
  const fmtView = new DataView(fmtChunk.buffer);
  writeAscii(fmtChunk, 0, "fmt ");
  fmtView.setUint32(4, 16, true);
  fmtView.setUint16(8, audioFormat, true);
  fmtView.setUint16(10, channels, true);
  fmtView.setUint32(12, sampleRate, true);
  fmtView.setUint32(16, sampleRate * channels * bytesPerSample, true);
  fmtView.setUint16(20, channels * bytesPerSample, true);
  fmtView.setUint16(22, bitsPerSample, true);

  const parts = [fmtChunk];

  if (options.extraChunk) {
    const { id, data } = options.extraChunk;
    const padded = data.length % 2 === 0 ? data.length : data.length + 1;
    const chunk = new Uint8Array(CHUNK_HEADER_BYTES + padded);
    const view = new DataView(chunk.buffer);
    writeAscii(chunk, 0, id);
    view.setUint32(4, data.length, true);
    chunk.set(data, CHUNK_HEADER_BYTES);
    parts.push(chunk);
  }

  const dataChunk = new Uint8Array(CHUNK_HEADER_BYTES + actualDataSize);
  const dataView = new DataView(dataChunk.buffer);
  writeAscii(dataChunk, 0, "data");
  dataView.setUint32(4, declaredDataSize, true);
  parts.push(dataChunk);

  const body = concatBytes(parts);
  const riff = new Uint8Array(12);
  const riffView = new DataView(riff.buffer);
  writeAscii(riff, 0, "RIFF");
  riffView.setUint32(4, 4 + body.length, true);
  writeAscii(riff, 8, "WAVE");

  return concatBytes([riff, body]);
}

function samplesForSeconds(seconds: number): number {
  return Math.round(seconds * SAMPLE_RATE);
}

function assertInvalidAudio(run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ContentError);
  const error = caught as ContentError;
  expect(error.code).toBe(DICTATION_ERROR_CODES.invalidAudio);
  expect(error.statusCode).toBe(400);
}

test("accepts a 3 s 16 kHz mono 16-bit file and reports its length", () => {
  const bytes = buildWav({ numSamples: samplesForSeconds(3) });
  const { durationSec } = readDictationWav(bytes);
  expect(durationSec).toBeCloseTo(3, 3);
});

test("accepts exactly 15 s", () => {
  const bytes = buildWav({ numSamples: samplesForSeconds(15) });
  const { durationSec } = readDictationWav(bytes);
  expect(durationSec).toBeCloseTo(15, 3);
});

describe("rejects invalid audio", () => {
  test.each([
    [
      "not RIFF",
      () => {
        const bytes = buildWav({ numSamples: samplesForSeconds(1) });
        writeAscii(bytes, 0, "JUNK");
        return bytes;
      },
    ],
    [
      "stereo",
      () => buildWav({ channels: 2, numSamples: samplesForSeconds(1) }),
    ],
    [
      "8 kHz",
      () => buildWav({ sampleRate: 8000, numSamples: samplesForSeconds(1) }),
    ],
    [
      "8-bit",
      () =>
        buildWav({ bitsPerSample: 8, numSamples: samplesForSeconds(1) }),
    ],
    [
      "float format tag 3",
      () => buildWav({ audioFormat: 3, numSamples: samplesForSeconds(1) }),
    ],
    ["empty data chunk", () => buildWav({ numSamples: 0 })],
    [
      "15.02 s",
      () => buildWav({ numSamples: samplesForSeconds(15.02) }),
    ],
    [
      "data size larger than the file",
      () =>
        buildWav({
          numSamples: samplesForSeconds(1),
          declaredDataSize: samplesForSeconds(1) * 2 * 1000,
        }),
    ],
    ["12 bytes", () => new Uint8Array(12)],
  ])("rejects %s with DICTATION_INVALID_AUDIO", (_label, build) => {
    const bytes = build();
    assertInvalidAudio(() => readDictationWav(bytes));
  });
});

test("finds the data chunk after an extra LIST chunk", () => {
  const bytes = buildWav({
    numSamples: samplesForSeconds(1),
    extraChunk: { id: "LIST", data: new Uint8Array([1, 2, 3]) },
  });
  const { durationSec } = readDictationWav(bytes);
  expect(durationSec).toBeCloseTo(1, 3);
});
