import { DICTATION_LIMITS } from "@sourceweft/contracts/dictation";
import {
  PcmCaptureFailure,
  type PcmCapture,
  type startPcmCapture,
} from "@sourceweft/ui-web/lib/audio/pcm-capture";
import {
  frameLevelDbfs,
  type createSpeechSegmenter,
  type SpeechSegment,
  type SpeechSegmenter,
} from "@sourceweft/ui-web/lib/audio/speech-segmenter";

import { joinDictationText } from "./join-text";
import {
  createSegmentTransport,
  type SegmentTransport,
  type SegmentTransportError,
} from "./segment-transport";

/** Why dictation stopped or could not run, shown beside the microphone button. */
export type DictationNotice =
  | "permission-denied"
  | "no-device"
  | "unsupported"
  | "insufficient-credits"
  | "unavailable"
  | "rate-limited"
  | "failed"
  | "silence-timeout"
  | "max-duration"
  | "device-lost";

export type DictationSnapshot =
  | { status: "idle"; notice: DictationNotice | null }
  | { status: "starting" }
  | { status: "listening"; startedAt: number; levelDbfs: number; pending: number }
  // The microphone is closed and the last segments' text is still arriving.
  | { status: "finishing"; pending: number };

export type DictationSession = {
  snapshot(): DictationSnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  /** Closes the microphone, flushes the open segment and resolves when pending text has been inserted. */
  stop(notice?: DictationNotice): Promise<void>;
  dispose(): void;
};

export type DictationSessionDeps = {
  startCapture: typeof startPcmCapture;
  createSegmenter: typeof createSpeechSegmenter;
  send(
    wav: Uint8Array,
    seq: number,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<{ text: string }>;
  insertText(text: string): boolean;
  now?: () => number;
  newSessionId?: () => string;
};

const SILENCE_LIMIT_MS = DICTATION_LIMITS.maxSilenceSeconds * 1000;
const SESSION_LIMIT_MS = DICTATION_LIMITS.maxSessionSeconds * 1000;
const LEVEL_THROTTLE_MS = 100;
const SILENT_LEVEL_DBFS = -100;

// A transport that has given up maps its reason to the notice shown to the user.
const TRANSPORT_ERROR_NOTICE: Record<
  SegmentTransportError["reason"],
  DictationNotice
> = {
  "insufficient-credits": "insufficient-credits",
  unavailable: "unavailable",
  "rate-limited": "rate-limited",
  failed: "failed",
};

function defaultSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // A good-enough fallback where crypto.randomUUID is missing; the id only
  // needs to be unique per run so a retried segment is not double counted.
  return `dictation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type Run = {
  id: string;
  segmenter: SpeechSegmenter;
  transport: SegmentTransport;
  capture: PcmCapture | null;
  // The last character this run inserted; a fresh run starts with "".
  tail: string;
  startedAt: number;
  levelDbfs: number;
  pending: number;
  lastLevelAt: number;
  closed: boolean;
  // Text waits here while an earlier run is still inserting its own.
  gate: Promise<void> | null;
  gatePassed: boolean;
  buffer: Array<{ text: string; endedBy: SpeechSegment["endedBy"] }>;
};

export function createDictationSession(
  deps: DictationSessionDeps,
): DictationSession {
  const now = deps.now ?? (() => Date.now());
  const newSessionId = deps.newSessionId ?? defaultSessionId;

  const listeners = new Set<() => void>();
  let snapshot: DictationSnapshot = { status: "idle", notice: null };
  let disposed = false;

  // The run that currently holds the microphone (status starting/listening).
  let activeRun: Run | null = null;
  // A stopped run whose segments are still being transcribed.
  let pendingFinish: Run | null = null;

  function setSnapshot(next: DictationSnapshot): void {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  }

  function refreshListening(run: Run): void {
    if (run !== activeRun || snapshot.status !== "listening") {
      return;
    }
    setSnapshot({
      status: "listening",
      startedAt: run.startedAt,
      levelDbfs: run.levelDbfs,
      pending: run.pending,
    });
  }

  function insertOne(
    run: Run,
    text: string,
    endedBy: SpeechSegment["endedBy"],
  ): void {
    if (disposed) {
      return;
    }
    const toInsert = joinDictationText(run.tail, text, {
      hardCut: endedBy === "cut",
    });
    if (toInsert.length === 0) {
      return;
    }
    const inserted = deps.insertText(toInsert);
    if (!inserted) {
      // The editor is gone: abort this run without a notice.
      abortRunSilently(run);
      return;
    }
    run.tail = toInsert[toInsert.length - 1]!;
  }

  function passGate(run: Run): void {
    if (run.gatePassed || disposed) {
      return;
    }
    run.gatePassed = true;
    const buffered = run.buffer.splice(0, run.buffer.length);
    for (const item of buffered) {
      insertOne(run, item.text, item.endedBy);
    }
  }

  function onRunText(
    run: Run,
    text: string,
    endedBy: SpeechSegment["endedBy"],
  ): void {
    if (disposed) {
      return;
    }
    if (!run.gatePassed) {
      run.buffer.push({ text, endedBy });
      return;
    }
    insertOne(run, text, endedBy);
  }

  function onRunPending(run: Run, pending: number): void {
    run.pending = pending;
    if (run === activeRun) {
      refreshListening(run);
    } else if (run === pendingFinish && snapshot.status === "finishing") {
      setSnapshot({ status: "finishing", pending });
    }
  }

  function onRunError(run: Run, error: SegmentTransportError): void {
    if (disposed) {
      return;
    }
    // The transport has already aborted itself; close the microphone and show
    // why. Text inserted before the failure stays in the composer.
    endRunWithNotice(run, TRANSPORT_ERROR_NOTICE[error.reason]);
  }

  function createRun(predecessor: Run | null): Run {
    const run: Run = {
      id: newSessionId(),
      segmenter: deps.createSegmenter(),
      // Assigned just below; the transport callbacks close over `run`.
      transport: undefined as unknown as SegmentTransport,
      capture: null,
      tail: "",
      startedAt: 0,
      levelDbfs: SILENT_LEVEL_DBFS,
      pending: 0,
      lastLevelAt: 0,
      closed: false,
      gate: predecessor ? predecessor.transport.whenIdle() : null,
      gatePassed: predecessor === null,
      buffer: [],
    };
    run.transport = createSegmentTransport({
      send: (wav, seq, signal) => deps.send(wav, seq, run.id, signal),
      onText: (text, segment) => onRunText(run, text, segment.endedBy),
      onError: (error) => onRunError(run, error),
      onPendingChange: (pending) => onRunPending(run, pending),
    });
    if (run.gate) {
      void run.gate.then(() => passGate(run));
    }
    return run;
  }

  function handleFrame(run: Run, frame: Int16Array): void {
    if (run !== activeRun || disposed) {
      return;
    }
    for (const segment of run.segmenter.push(frame)) {
      run.transport.enqueue(segment);
    }

    const at = now();
    if (at - run.lastLevelAt >= LEVEL_THROTTLE_MS) {
      run.lastLevelAt = at;
      run.levelDbfs = frameLevelDbfs(frame);
      refreshListening(run);
    }

    if (run.segmenter.msSinceSpeech() >= SILENCE_LIMIT_MS) {
      void stop("silence-timeout");
      return;
    }
    if (at - run.startedAt >= SESSION_LIMIT_MS) {
      void stop("max-duration");
    }
  }

  function handleEnded(run: Run): void {
    if (run !== activeRun || disposed) {
      return;
    }
    endRunWithNotice(run, "device-lost");
  }

  function abortRunSilently(run: Run): void {
    run.capture?.stop();
    run.capture = null;
    run.closed = true;
    run.transport.abort();
    if (run === activeRun) {
      activeRun = null;
    }
    if (run === pendingFinish) {
      pendingFinish = null;
    }
    if (!activeRun && !disposed) {
      setSnapshot({ status: "idle", notice: null });
    }
  }

  function endRunWithNotice(run: Run, notice: DictationNotice): void {
    run.capture?.stop();
    run.capture = null;
    run.closed = true;
    run.transport.abort();
    if (run === activeRun) {
      activeRun = null;
    }
    if (run === pendingFinish) {
      pendingFinish = null;
    }
    // Only reflect the notice when no newer run has taken the microphone.
    if (!activeRun && !disposed) {
      setSnapshot({ status: "idle", notice });
    }
  }

  async function start(): Promise<void> {
    if (disposed || activeRun) {
      return;
    }
    const run = createRun(pendingFinish);
    activeRun = run;
    setSnapshot({ status: "starting" });

    let capture: PcmCapture;
    try {
      capture = await deps.startCapture({
        onFrame: (frame) => handleFrame(run, frame),
        onEnded: () => handleEnded(run),
      });
    } catch (error) {
      if (run === activeRun) {
        activeRun = null;
      }
      run.transport.abort();
      const notice: DictationNotice =
        error instanceof PcmCaptureFailure ? error.reason : "failed";
      if (!activeRun && !disposed) {
        setSnapshot({ status: "idle", notice });
      }
      return;
    }

    if (run !== activeRun || disposed) {
      // Stopped or disposed while the permission prompt was open.
      capture.stop();
      run.transport.abort();
      return;
    }

    run.capture = capture;
    run.startedAt = now();
    run.lastLevelAt = run.startedAt - LEVEL_THROTTLE_MS;
    setSnapshot({
      status: "listening",
      startedAt: run.startedAt,
      levelDbfs: run.levelDbfs,
      pending: run.transport.pending(),
    });
  }

  async function stop(notice?: DictationNotice): Promise<void> {
    if (disposed) {
      return;
    }
    const run = activeRun;
    if (!run) {
      // Nothing is capturing; wait for a finishing run's text to land.
      if (pendingFinish) {
        await pendingFinish.transport.whenIdle();
      }
      return;
    }

    activeRun = null;
    run.capture?.stop();
    run.capture = null;
    run.closed = true;

    const flushed = run.segmenter.flush();
    if (flushed) {
      run.transport.enqueue(flushed);
    }

    pendingFinish = run;
    setSnapshot({ status: "finishing", pending: run.transport.pending() });

    await run.transport.whenIdle();

    if (run === pendingFinish && !disposed) {
      pendingFinish = null;
      if (!activeRun) {
        setSnapshot({ status: "idle", notice: notice ?? null });
      }
    }
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const run of [activeRun, pendingFinish]) {
      if (run) {
        run.capture?.stop();
        run.capture = null;
        run.transport.abort();
      }
    }
    activeRun = null;
    pendingFinish = null;
    setSnapshot({ status: "idle", notice: null });
  }

  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop,
    dispose,
  };
}
