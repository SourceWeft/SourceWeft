import { spawn } from "node:child_process";

/**
 * The one place the backend runs ffmpeg. Audio work is CPU-bound, so every
 * caller shares one process-wide bound: ingestion and narration must not stack
 * up ffmpeg processes on a worker.
 */
const MAX_CONCURRENT_FFMPEG = 2;
const STDERR_TAIL_BYTES = 2_000;

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

export const ffmpegSemaphore = new Semaphore(MAX_CONCURRENT_FFMPEG);

/** Runs ffmpeg to completion; rejects on a non-zero exit, timeout or abort. */
export function runFfmpeg(input: {
  ffmpegPath: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  /** Log lines containing this text are returned; the rest is dropped. */
  keepLines?: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.ffmpegPath, input.args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let matched = "";
    let tail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-STDERR_TAIL_BYTES);
      for (const line of chunk.split("\n")) {
        if (input.keepLines && line.includes(input.keepLines)) {
          matched += `${line}\n`;
        }
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
    const onAbort = () => kill(new Error("Audio processing was aborted"));
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
              `ffmpeg is required to process this audio but '${input.ffmpegPath}' was not found on PATH`,
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
            `ffmpeg could not process the audio (exit ${code}): ${detail}`,
          ),
        );
      }
      resolve(matched);
    });
  });
}
