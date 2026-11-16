const OUTPUT_SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (OUTPUT_SAMPLE_RATE * FRAME_MS) / 1000;
const PROCESSOR_NAME = "sourceweft-pcm-passthrough";

// Runs in the AudioWorkletGlobalScope, loaded from a Blob URL: posts a copy of
// each rendered input block to the main thread, unchanged.
const WORKLET_SOURCE = `
class PcmPassthroughProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice());
    return true;
  }
}
registerProcessor(${JSON.stringify(PROCESSOR_NAME)}, PcmPassthroughProcessor);
`;

export type PcmCaptureFailureReason = "permission-denied" | "no-device" | "unsupported" | "failed";

export class PcmCaptureFailure extends Error {
  readonly reason: PcmCaptureFailureReason;

  constructor(reason: PcmCaptureFailureReason, message?: string) {
    super(message ?? reason);
    this.name = "PcmCaptureFailure";
    this.reason = reason;
  }
}

export type PcmCapture = { stop(): void };

export function isPcmCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof AudioWorkletNode !== "undefined"
  );
}

function floatToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped * 32767);
}

function mapGetUserMediaError(error: unknown): PcmCaptureFailureReason {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "permission-denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "no-device";
    case "NotSupportedError":
    case "TypeError":
      return "unsupported";
    default:
      return "failed";
  }
}

/**
 * Resamples blocks at `inputRate` to 16 kHz with linear interpolation, and
 * returns every whole 320-sample (20 ms) frame the resampled stream has
 * completed so far. A trailing partial frame is kept for the next push.
 */
export function createFrameAssembler(inputRate: number): { push(block: Float32Array): Int16Array[] } {
  const step = inputRate / OUTPUT_SAMPLE_RATE;

  // Position, in input-sample units, of the next output sample to produce.
  // Spans across pushes, so resampling stays continuous at block boundaries.
  let pendingPos = 0;
  let totalConsumed = 0;
  let prevSample = 0;
  const pendingSamples: number[] = [];

  function sampleAt(globalIndex: number, block: Float32Array, blockStart: number): number {
    return globalIndex < blockStart ? prevSample : block[globalIndex - blockStart]!;
  }

  function push(block: Float32Array): Int16Array[] {
    const blockStart = totalConsumed;
    const blockEnd = blockStart + block.length - 1;

    for (;;) {
      const i0 = Math.floor(pendingPos);
      const frac = pendingPos - i0;

      if (frac === 0) {
        if (i0 > blockEnd) break;
        pendingSamples.push(floatToInt16(sampleAt(i0, block, blockStart)));
      } else {
        if (i0 + 1 > blockEnd) break;
        const s0 = sampleAt(i0, block, blockStart);
        const s1 = sampleAt(i0 + 1, block, blockStart);
        pendingSamples.push(floatToInt16(s0 + (s1 - s0) * frac));
      }
      pendingPos += step;
    }

    if (block.length > 0) prevSample = block[block.length - 1]!;
    totalConsumed += block.length;

    const frames: Int16Array[] = [];
    while (pendingSamples.length >= SAMPLES_PER_FRAME) {
      frames.push(Int16Array.from(pendingSamples.splice(0, SAMPLES_PER_FRAME)));
    }
    return frames;
  }

  return { push };
}

/**
 * Opens the microphone and streams 16 kHz mono frames to `onFrame` until
 * `stop()` is called. Throws `PcmCaptureFailure` for every failure path, and
 * releases whatever it already opened before throwing.
 */
export async function startPcmCapture(input: {
  onFrame(frame: Int16Array): void;
  /** The device went away (unplugged, permission revoked). */
  onEnded?(): void;
}): Promise<PcmCapture> {
  if (!isPcmCaptureSupported()) {
    throw new PcmCaptureFailure("unsupported", "Microphone capture is not supported in this environment.");
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (error) {
    throw new PcmCaptureFailure(mapGetUserMediaError(error), "Failed to open the microphone.");
  }

  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  const context = new AudioContext();

  let workletUrl: string | null = null;
  try {
    workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    await context.audioWorklet.addModule(workletUrl);
  } catch {
    stopTracks();
    await context.close().catch(() => {});
    throw new PcmCaptureFailure("failed", "Failed to load the capture audio worklet.");
  } finally {
    if (workletUrl) URL.revokeObjectURL(workletUrl);
  }

  let sourceNode: MediaStreamAudioSourceNode;
  let workletNode: AudioWorkletNode;
  try {
    sourceNode = context.createMediaStreamSource(stream);
    workletNode = new AudioWorkletNode(context, PROCESSOR_NAME);
  } catch {
    stopTracks();
    await context.close().catch(() => {});
    throw new PcmCaptureFailure("failed", "Failed to build the capture audio graph.");
  }

  const assembler = createFrameAssembler(context.sampleRate);
  let stopped = false;

  workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (stopped) return;
    for (const frame of assembler.push(event.data)) input.onFrame(frame);
  };

  const [track] = stream.getAudioTracks();
  track?.addEventListener("ended", () => {
    if (stopped) return;
    input.onEnded?.();
  });

  sourceNode.connect(workletNode);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    stopTracks();
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    sourceNode.disconnect();
    void context.close();
  }

  return { stop };
}
