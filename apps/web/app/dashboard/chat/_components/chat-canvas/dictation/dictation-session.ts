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
  /** True once disposed; a disposed session is never reused. */
  isDisposed(): boolean;
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

/**
 * A RFC 4122 version-4 UUID built from `crypto.getRandomValues` (falling back
 * to `Math.random` only when that too is missing). The dictation route requires
 * a UUID session id, so the fallback for an environment without
 * `crypto.randomUUID` must still produce a valid one.
 */
export function fallbackSessionId(): string {
  const bytes = new Uint8Array(16);
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return (
    `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-` +
    `${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-` +
    `${hex.slice(10, 16).join("")}`
  );
}

function defaultSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return fallbackSessionId();
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
  // True once this run may insert: its predecessor has finished inserting all
  // of its own text. Until then text waits in `buffer`.
  gatePassed: boolean;
  buffer: Array<{ text: string; endedBy: SpeechSegment["endedBy"] }>;
  // Resolves once this run has inserted all its text (or ended in an error) and
  // its predecessor has done the same. Runs chain on it so text lands run by
  // run, segment by segment, in order and exactly once.
  done: Promise<void>;
  resolveDone: () => void;
  doneResolved: boolean;
  // The notice to show when this run is the last to finish.
  stopNotice: DictationNotice | null;
  // The 10-minute cap timer, armed while this run holds the microphone.
  sessionTimer: ReturnType<typeof setTimeout> | null;
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
  // The most recently created run (active or finishing); the tail of the chain.
  let lastRun: Run | null = null;
  // Stopped runs whose segments are still being transcribed and inserted.
  const finishingRuns = new Set<Run>();

  function finishingPending(): number {
    let total = 0;
    for (const run of finishingRuns) {
      total += run.transport.pending();
    }
    return total;
  }

  // The newest run that has not finished inserting; a new run chains on it.
  function unfinishedTail(): Run | null {
    return lastRun && !lastRun.doneResolved ? lastRun : null;
  }

  function clearSessionTimer(run: Run): void {
    if (run.sessionTimer !== null) {
      clearTimeout(run.sessionTimer);
      run.sessionTimer = null;
    }
  }

  function armSessionTimer(run: Run): void {
    clearSessionTimer(run);
    // A timer is needed as well as the per-frame check: if frames stop arriving
    // while the track is still live, the microphone would otherwise stay open.
    run.sessionTimer = setTimeout(() => {
      void stop("max-duration");
    }, SESSION_LIMIT_MS);
  }

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
      // The editor is gone: tear this run down without a notice.
      teardownRun(run, null);
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
    maybeFinishRun(run);
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
    } else if (snapshot.status === "finishing") {
      setSnapshot({ status: "finishing", pending: finishingPending() });
    }
    maybeFinishRun(run);
  }

  function onRunError(run: Run, error: SegmentTransportError): void {
    if (disposed) {
      return;
    }
    // The transport has already aborted itself; close the microphone and show
    // why. Text inserted before the failure stays in the composer, and the
    // run's `done` resolves so any successor is never blocked by the failure.
    teardownRun(run, TRANSPORT_ERROR_NOTICE[error.reason]);
  }

  // A closed run is done once its predecessor has finished inserting (so its own
  // gate is open and its buffer is flushed) and its transport has delivered
  // everything. An active run is never finished here — it still holds the mic.
  function maybeFinishRun(run: Run): void {
    if (run.doneResolved || disposed) {
      return;
    }
    if (!run.closed || !run.gatePassed) {
      return;
    }
    if (run.transport.pending() !== 0) {
      return;
    }
    resolveRunDone(run);
  }

  function resolveRunDone(run: Run): void {
    if (run.doneResolved) {
      return;
    }
    run.doneResolved = true;
    finishingRuns.delete(run);
    run.resolveDone();
    if (!activeRun && !disposed && finishingRuns.size === 0) {
      setSnapshot({ status: "idle", notice: run.stopNotice });
    }
  }

  function createRun(predecessor: Run | null): Run {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
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
      gatePassed: predecessor === null,
      buffer: [],
      done,
      resolveDone,
      doneResolved: false,
      stopNotice: null,
      sessionTimer: null,
    };
    run.transport = createSegmentTransport({
      send: (wav, seq, signal) => deps.send(wav, seq, run.id, signal),
      onText: (text, segment) => onRunText(run, text, segment.endedBy),
      onError: (error) => onRunError(run, error),
      onPendingChange: (pending) => onRunPending(run, pending),
    });
    if (predecessor) {
      // This run may only insert once its predecessor has finished inserting
      // all of its own text, so the chain stays in order.
      void predecessor.done.then(() => passGate(run));
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
    teardownRun(run, "device-lost");
  }

  // Closes a run's microphone, abandons its undelivered segments and resolves
  // its `done` so successors are never blocked. With a notice it is shown when
  // this run turns out to be the last to finish.
  function teardownRun(run: Run, notice: DictationNotice | null): void {
    clearSessionTimer(run);
    run.capture?.stop();
    run.capture = null;
    run.closed = true;
    run.transport.abort();
    if (notice !== null) {
      run.stopNotice = notice;
    }
    if (run === activeRun) {
      activeRun = null;
    }
    resolveRunDone(run);
  }

  async function start(): Promise<void> {
    if (disposed || activeRun) {
      return;
    }
    const run = createRun(unfinishedTail());
    activeRun = run;
    lastRun = run;
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
      run.stopNotice =
        error instanceof PcmCaptureFailure ? error.reason : "failed";
      // Resolve `done` (unblocking any successor) and, when nothing else is
      // finishing, surface the notice.
      resolveRunDone(run);
      return;
    }

    if (run !== activeRun || disposed) {
      // Stopped or disposed while the permission prompt was open.
      capture.stop();
      run.transport.abort();
      resolveRunDone(run);
      return;
    }

    run.capture = capture;
    run.startedAt = now();
    run.lastLevelAt = run.startedAt - LEVEL_THROTTLE_MS;
    armSessionTimer(run);
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
      // Nothing is capturing; wait for the finishing chain's text to land.
      const tail = unfinishedTail();
      if (tail) {
        await tail.done;
      }
      return;
    }

    clearSessionTimer(run);
    activeRun = null;
    run.capture?.stop();
    run.capture = null;
    run.closed = true;
    run.stopNotice = notice ?? null;

    const flushed = run.segmenter.flush();
    if (flushed) {
      run.transport.enqueue(flushed);
    }

    finishingRuns.add(run);
    setSnapshot({ status: "finishing", pending: finishingPending() });
    // The run may already be done (no pending segments, e.g. a silence stop).
    maybeFinishRun(run);

    await run.done;
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    const runs = new Set<Run>(finishingRuns);
    if (activeRun) {
      runs.add(activeRun);
    }
    for (const run of runs) {
      clearSessionTimer(run);
      run.capture?.stop();
      run.capture = null;
      run.transport.abort();
      if (!run.doneResolved) {
        run.doneResolved = true;
        run.resolveDone();
      }
    }
    activeRun = null;
    lastRun = null;
    finishingRuns.clear();
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
    isDisposed: () => disposed,
  };
}
