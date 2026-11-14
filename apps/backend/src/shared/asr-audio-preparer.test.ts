import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
  createFfmpegAsrAudioPreparer,
  parseSilenceLog,
} from "./asr-audio-preparer";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("parseSilenceLog pairs starts with ends and ignores noise", () => {
  const log = [
    "[silencedetect @ 0x1] silence_start: 1.5",
    "[silencedetect @ 0x1] silence_end: 2.25 | silence_duration: 0.75",
    "something else",
    "[silencedetect @ 0x1] silence_end: 9",
    "[silencedetect @ 0x1] silence_start: -0.01",
    "[silencedetect @ 0x1] silence_end: 0.5 | silence_duration: 0.51",
    "[silencedetect @ 0x1] silence_start: 20",
  ].join("\n");
  assert.deepEqual(parseSilenceLog(log), [
    { startSec: 1.5, endSec: 2.25 },
    { startSec: 0, endSec: 0.5 },
  ]);
});

test("a missing ffmpeg binary fails with a clear message and leaves no temp dir", async () => {
  const preparer = createFfmpegAsrAudioPreparer({
    ffmpegPath: "ffmpeg-definitely-not-installed",
  });
  const before = readdirSync(tmpdir()).filter((name) =>
    name.startsWith("sw-asr-"),
  );
  await assert.rejects(
    () =>
      preparer.normalize({
        audio: new Uint8Array([1, 2, 3]),
        fileName: "a.mp3",
      }),
    /ffmpeg is required/,
  );
  const after = readdirSync(tmpdir()).filter((name) =>
    name.startsWith("sw-asr-"),
  );
  assert.deepEqual(after, before);
});

describe.skipIf(!hasFfmpeg)("with a real ffmpeg", () => {
  let dir: string;
  const fixture = (name: string) =>
    new Uint8Array(readFileSync(join(dir, name)));

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sw-asr-fixture-"));
    // 2 s tone, 1 s silence, 2 s tone: 5 s in total.
    const tone =
      "sine=frequency=440:duration=2[a];anullsrc=r=44100:cl=mono,atrim=duration=1[s];sine=frequency=660:duration=2[b];[a][s][b]concat=n=3:v=0:a=1[out]";
    const run = (args: string[]) =>
      execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args]);
    run([
      "-filter_complex",
      tone,
      "-map",
      "[out]",
      "-ac",
      "2",
      "-ar",
      "44100",
      join(dir, "stereo.mp3"),
    ]);
    run([
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:d=5",
      "-filter_complex",
      tone,
      "-map",
      "0:v",
      "-map",
      "[out]",
      "-c:v",
      "mpeg4",
      "-c:a",
      "aac",
      "-shortest",
      join(dir, "video.mp4"),
    ]);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("decodes a stereo mp3 to 16 kHz mono PCM and finds the silence", async () => {
    const preparer = createFfmpegAsrAudioPreparer();
    const audio = await preparer.normalize({
      audio: fixture("stereo.mp3"),
      fileName: "stereo.mp3",
      mimeType: "audio/mpeg",
    });
    try {
      assert.equal(audio.sampleRate, 16_000);
      const seconds = audio.pcmByteLength / 2 / 16_000;
      assert.ok(Math.abs(seconds - 5) < 0.2, String(seconds));
      assert.equal(audio.silences.length, 1);
      const silence = audio.silences[0];
      assert.ok(silence && Math.abs(silence.startSec - 2) < 0.2);
      assert.ok(silence && Math.abs(silence.endSec - 3) < 0.2);

      const slice = await audio.readPcm(32_000, 64_000);
      assert.equal(slice.byteLength, 32_000);
      assert.ok(slice.some((byte) => byte !== 0));
      const quiet = await audio.readPcm(2.3 * 32_000, 2.7 * 32_000);
      assert.ok(
        quiet.every((byte) => byte === 0 || byte === 255 || byte === 1),
      );
    } finally {
      await audio.dispose();
    }
  });

  test("takes the audio track of a video file", async () => {
    const preparer = createFfmpegAsrAudioPreparer();
    const audio = await preparer.normalize({
      audio: fixture("video.mp4"),
      fileName: "video.mp4",
      mimeType: "video/mp4",
    });
    try {
      const seconds = audio.pcmByteLength / 2 / 16_000;
      assert.ok(Math.abs(seconds - 5) < 0.3, String(seconds));
    } finally {
      await audio.dispose();
    }
  });

  test("dispose removes the decoded audio", async () => {
    const preparer = createFfmpegAsrAudioPreparer();
    const audio = await preparer.normalize({
      audio: fixture("stereo.mp3"),
      fileName: "stereo.mp3",
    });
    await audio.dispose();
    await assert.rejects(() => audio.readPcm(0, 10));
  });

  test("a file that is not audio fails with ffmpeg's reason", async () => {
    const preparer = createFfmpegAsrAudioPreparer();
    await assert.rejects(
      () =>
        preparer.normalize({
          audio: new TextEncoder().encode("not audio at all"),
          fileName: "fake.mp3",
        }),
      /ffmpeg could not decode/,
    );
  });

  test("probes the duration without decoding", async () => {
    const preparer = createFfmpegAsrAudioPreparer();
    const seconds = await preparer.probeDurationSec({
      audio: fixture("stereo.mp3"),
      fileName: "stereo.mp3",
      mimeType: "audio/mpeg",
    });
    assert.ok(seconds !== null && Math.abs(seconds - 5) < 0.3, String(seconds));
  });
});
