import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { probeAudioDurationSeconds } from "./audio-duration";
import { createFfmpegTtsAudioTranscoder } from "./tts-audio-transcoder";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("an unknown target format is refused with the supported list", async () => {
  await assert.rejects(
    () =>
      createFfmpegTtsAudioTranscoder().transcode({
        audio: new Uint8Array([1]),
        fromFormat: "wav",
        toFormat: "wma",
      }),
    /Cannot convert speech to 'wma'.*mp3/,
  );
});

test("a missing ffmpeg binary fails with a clear message", async () => {
  await assert.rejects(
    () =>
      createFfmpegTtsAudioTranscoder({
        ffmpegPath: "ffmpeg-definitely-not-installed",
      }).transcode({
        audio: new Uint8Array([1]),
        fromFormat: "wav",
        toFormat: "mp3",
      }),
    /ffmpeg is required/,
  );
});

describe.skipIf(!hasFfmpeg)("with a real ffmpeg", () => {
  let dir: string;
  let wav: Uint8Array;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sw-tts-fixture-"));
    const path = join(dir, "speech.wav");
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=3",
      "-ar",
      "24000",
      "-ac",
      "1",
      path,
    ]);
    wav = new Uint8Array(readFileSync(path));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const magic = (bytes: Uint8Array, length = 4) =>
    String.fromCharCode(...bytes.subarray(0, length));

  test("wav becomes a playable mp3 of the same length", async () => {
    const mp3 = await createFfmpegTtsAudioTranscoder().transcode({
      audio: wav,
      fromFormat: "wav",
      toFormat: "mp3",
    });
    assert.ok(mp3.byteLength > 1_000 && mp3.byteLength < wav.byteLength);
    assert.ok(magic(mp3, 3) === "ID3" || mp3[0] === 0xff);
    const seconds = await probeAudioDurationSeconds({
      buffer: Buffer.from(mp3),
      mimeType: "audio/mpeg",
    });
    assert.ok(seconds !== null && Math.abs(seconds - 3) < 0.2, String(seconds));
  });

  test("wav converts to opus, aac, flac and raw pcm", async () => {
    const transcoder = createFfmpegTtsAudioTranscoder();
    const to = (toFormat: string) =>
      transcoder.transcode({ audio: wav, fromFormat: "wav", toFormat });
    assert.equal(magic(await to("opus")), "OggS");
    assert.equal(magic(await to("flac")), "fLaC");
    assert.equal((await to("aac"))[0], 0xff);
    const pcm = await to("pcm");
    assert.ok(Math.abs(pcm.byteLength - 3 * 24_000 * 2) < 2_000);
  });

  test("input that is not audio fails with ffmpeg's reason", async () => {
    await assert.rejects(
      () =>
        createFfmpegTtsAudioTranscoder().transcode({
          audio: new TextEncoder().encode("not audio"),
          fromFormat: "wav",
          toFormat: "mp3",
        }),
      /ffmpeg could not process/,
    );
  });
});
