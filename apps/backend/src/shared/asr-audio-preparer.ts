import { spawn } from "node:child_process";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type {
  AsrAudioPreparer,
  AsrAudioSource,
  AsrSilence,
  NormalizedAsrAudio,
} from "@sourceweft/model-gateway";
import { probeAudioDurationSeconds } from "./audio-duration";

/**
 * ffmpeg-backed audio decoding for ASR providers that cannot take an upload
 * as it is (wrong container, too large, too long).
 *
 * One ffmpeg pass decodes the first audio stream to 16 kHz mono 16-bit PCM
 * and reports silences in the same run; chunks are then cut from that PCM by
 * byte range, so ffmpeg never runs a second time. Audio only: `-vn` skips the
 * picture of a video file. The input goes through a temp file because an mp4
 * whose index sits at the end cannot be read from a pipe.
 */
const SAMPLE_RATE = 16_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// Decoding is CPU-bound; ingestion workers must not stack up ffmpeg processes.
const DEFAULT_MAX_CONCURRENT = 2;
const SILENCE_FILTER = "silencedetect=noise=-35dB:d=0.4";
const STDERR_TAIL_BYTES = 2_000;

export type FfmpegAsrAudioPreparerOptions = {
  readonly ffmpegPath?: string;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
};

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

/** Reads `silence_start` / `silence_end` pairs out of ffmpeg's log. */
export function parseSilenceLog(log: string): AsrSilence[] {
  const silences: AsrSilence[] = [];
  let start: number | undefined;
  for (const match of log.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    if (match[1] === "start") {
      start = Math.max(0, value);
    } else if (start !== undefined) {
      if (value > start) silences.push({ startSec: start, endSec: value });
      start = undefined;
    }
  }
  return silences;
}

function runFfmpeg(input: {
  ffmpegPath: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.ffmpegPath, input.args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let silenceLog = "";
    let tail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-STDERR_TAIL_BYTES);
      for (const line of chunk.split("\n")) {
        if (line.includes("silence_")) silenceLog += `${line}\n`;
      }
    });

    let failure: Error | undefined;
    const kill = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () =>
        kill(new Error(`ffmpeg did not finish within ${input.timeoutMs}ms`)),
      input.timeoutMs,
    );
    const onAbort = () => kill(new Error("Audio decoding was aborted"));
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish();
      reject(
        error.code === "ENOENT"
          ? new Error(
              `ffmpeg is required to decode this audio but '${input.ffmpegPath}' was not found on PATH`,
            )
          : error,
      );
    });
    child.on("close", (code) => {
      finish();
      if (failure) return reject(failure);
      if (code !== 0) {
        const detail = tail.trim().split("\n").slice(-3).join(" | ");
        return reject(
          new Error(
            `ffmpeg could not decode the audio (exit ${code}): ${detail}`,
          ),
        );
      }
      resolve(silenceLog);
    });
  });
}

export function createFfmpegAsrAudioPreparer(
  options: FfmpegAsrAudioPreparerOptions = {},
): AsrAudioPreparer {
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const semaphore = new Semaphore(
    Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT),
  );

  return {
    async probeDurationSec(source: AsrAudioSource) {
      return probeAudioDurationSeconds({
        buffer: Buffer.from(
          source.audio.buffer,
          source.audio.byteOffset,
          source.audio.byteLength,
        ),
        mimeType: source.mimeType ?? "application/octet-stream",
      });
    },

    async normalize(
      source: AsrAudioSource,
      signal?: AbortSignal,
    ): Promise<NormalizedAsrAudio> {
      signal?.throwIfAborted();
      const dir = await mkdtemp(join(tmpdir(), "sw-asr-"));
      const dispose = () => rm(dir, { recursive: true, force: true });
      try {
        const extension = /^\.[a-z0-9]{1,5}$/i.test(extname(source.fileName))
          ? extname(source.fileName).toLowerCase()
          : "";
        const inputPath = join(dir, `input${extension}`);
        const pcmPath = join(dir, "audio.pcm");
        await writeFile(inputPath, source.audio);

        const silenceLog = await semaphore.run(() =>
          runFfmpeg({
            ffmpegPath,
            timeoutMs,
            signal,
            args: [
              "-hide_banner",
              "-nostdin",
              "-nostats",
              "-threads",
              "1",
              "-i",
              inputPath,
              "-vn",
              "-map",
              "0:a:0",
              "-af",
              SILENCE_FILTER,
              "-ac",
              "1",
              "-ar",
              String(SAMPLE_RATE),
              "-f",
              "s16le",
              "-acodec",
              "pcm_s16le",
              "-y",
              pcmPath,
            ],
          }),
        );

        const { size } = await stat(pcmPath);
        return {
          sampleRate: SAMPLE_RATE,
          pcmByteLength: size - (size % 2),
          silences: parseSilenceLog(silenceLog),
          async readPcm(byteStart, byteEnd) {
            const length = Math.max(0, byteEnd - byteStart);
            const buffer = Buffer.alloc(length);
            const handle = await open(pcmPath, "r");
            try {
              const { bytesRead } = await handle.read(
                buffer,
                0,
                length,
                byteStart,
              );
              return new Uint8Array(
                buffer.buffer,
                buffer.byteOffset,
                bytesRead,
              );
            } finally {
              await handle.close();
            }
          },
          dispose,
        };
      } catch (error) {
        await dispose();
        throw error;
      }
    },
  };
}

/** Shared by every gateway client so the ffmpeg bound is process-wide. */
export const ffmpegAsrAudioPreparer = createFfmpegAsrAudioPreparer();
