export const SEGMENTER_DEFAULTS = {
  sampleRate: 16000,
  frameMs: 20,
  speechMarginDb: 12,
  minSpeechDbfs: -45,
  initialFloorDbfs: -60,
  minFloorDbfs: -90,
  floorRiseDbPerSecond: 1.5,
  startSpeechMs: 100,
  preRollMs: 240,
  endSilenceMs: 600,
  postRollMs: 200,
  maxSegmentMs: 15000,
  cutSearchMs: 2000,
  minSpeechMs: 300,
} as const;

export type SegmenterOptions = { [K in keyof typeof SEGMENTER_DEFAULTS]: number };

export type SpeechSegment = {
  samples: Int16Array;
  durationMs: number;
  endedBy: "pause" | "cut" | "flush";
};

export type SpeechSegmenter = {
  /** One frame of exactly sampleRate * frameMs / 1000 samples. */
  push(frame: Int16Array): SpeechSegment[];
  /** Ends the open segment, if it holds at least minSpeechMs of speech. */
  flush(): SpeechSegment | null;
  /** Milliseconds of frames pushed since the last speech frame (0 while speaking). */
  msSinceSpeech(): number;
};

/** RMS level of a frame in dBFS, relative to full scale for Int16 samples. */
export function frameLevelDbfs(frame: Int16Array): number {
  if (frame.length === 0) return -100;

  let sumSquares = 0;
  for (let i = 0; i < frame.length; i++) {
    const sample = frame[i]! / 32768;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / frame.length);
  return rms === 0 ? -100 : 20 * Math.log10(rms);
}

type SegmentEntry = { frame: Int16Array; isSpeech: boolean };

function concatFrames(entries: SegmentEntry[]): Int16Array {
  const samplesPerFrame = entries.length > 0 ? entries[0]!.frame.length : 0;
  const out = new Int16Array(entries.length * samplesPerFrame);
  entries.forEach((entry, i) => out.set(entry.frame, i * samplesPerFrame));
  return out;
}

function speechMsOf(entries: SegmentEntry[], frameMs: number): number {
  return entries.filter((entry) => entry.isSpeech).length * frameMs;
}

export function createSpeechSegmenter(options?: Partial<SegmenterOptions>): SpeechSegmenter {
  const opts: SegmenterOptions = { ...SEGMENTER_DEFAULTS, ...options };

  const msToFrames = (ms: number) => Math.round(ms / opts.frameMs);
  const startSpeechFrames = msToFrames(opts.startSpeechMs);
  const preRollFrames = msToFrames(opts.preRollMs);
  const endSilenceFrames = msToFrames(opts.endSilenceMs);
  const postRollFrames = msToFrames(opts.postRollMs);
  const maxSegmentFrames = msToFrames(opts.maxSegmentMs);
  const cutSearchFrames = msToFrames(opts.cutSearchMs);

  // Noise floor: drops to a quieter level at once, rises towards a louder
  // one slowly, so it tracks room noise without creeping into real speech.
  let floor = opts.initialFloorDbfs;
  let msSinceSpeechCount = 0;
  const ring: Int16Array[] = [];

  let mode: "idle" | "open" = "idle";
  // An unconfirmed run of speech frames seen while idle. All entries here
  // are speech by construction: any silent frame aborts the candidate.
  let pending: SegmentEntry[] | null = null;
  let pendingPreroll: Int16Array[] = [];
  let openEntries: SegmentEntry[] = [];

  function ringPush(frame: Int16Array): void {
    ring.push(frame);
    if (ring.length > preRollFrames) ring.shift();
  }

  function finalizeAsSegment(
    entries: SegmentEntry[],
    endedBy: SpeechSegment["endedBy"],
  ): SpeechSegment | null {
    if (entries.length === 0) return null;
    const speechMs = speechMsOf(entries, opts.frameMs);
    if (speechMs < opts.minSpeechMs) return null;
    return {
      samples: concatFrames(entries),
      durationMs: entries.length * opts.frameMs,
      endedBy,
    };
  }

  function cutOpenSegment(): SpeechSegment | null {
    const windowLength = Math.min(cutSearchFrames, openEntries.length);
    const windowStart = openEntries.length - windowLength;
    let cutIndex = windowStart;
    let cutLevel = Infinity;
    for (let i = windowStart; i < openEntries.length; i++) {
      const level = frameLevelDbfs(openEntries[i]!.frame);
      if (level < cutLevel) {
        cutLevel = level;
        cutIndex = i;
      }
    }
    const segment1 = openEntries.slice(0, cutIndex + 1);
    const segment2 = openEntries.slice(cutIndex + 1);
    // The frames after the cut point open the next segment, already speaking.
    openEntries = segment2;
    return finalizeAsSegment(segment1, "cut");
  }

  function push(frame: Int16Array): SpeechSegment[] {
    const level = frameLevelDbfs(frame);
    const threshold = Math.max(floor + opts.speechMarginDb, opts.minSpeechDbfs);
    const isSpeech = level > threshold;

    // The floor is updated after the frame is classified.
    if (level < floor) {
      floor = Math.max(level, opts.minFloorDbfs);
    } else {
      const rise = opts.floorRiseDbPerSecond * (opts.frameMs / 1000);
      floor = Math.min(level, floor + rise);
    }

    if (isSpeech) {
      msSinceSpeechCount = 0;
    } else {
      msSinceSpeechCount += opts.frameMs;
    }

    const results: SpeechSegment[] = [];

    if (mode === "open") {
      openEntries.push({ frame, isSpeech });

      if (openEntries.length >= maxSegmentFrames) {
        const cut = cutOpenSegment();
        if (cut) results.push(cut);
      } else if (!isSpeech && msSinceSpeechCount >= opts.endSilenceMs) {
        const keep = Math.max(openEntries.length - endSilenceFrames + postRollFrames, 0);
        const trimmed = openEntries.slice(0, keep);
        const segment = finalizeAsSegment(trimmed, "pause");
        if (segment) results.push(segment);
        mode = "idle";
        openEntries = [];
      }
    } else if (isSpeech) {
      if (pending === null) {
        pending = [];
        pendingPreroll = ring.slice();
      }
      pending.push({ frame, isSpeech: true });

      if (pending.length >= startSpeechFrames) {
        const preroll: SegmentEntry[] = pendingPreroll.map((f) => ({
          frame: f,
          isSpeech: false,
        }));
        openEntries = [...preroll, ...pending];
        mode = "open";
        pending = null;
        pendingPreroll = [];
      }
    } else if (pending !== null) {
      // Silence returned before startSpeechMs was reached: not real speech.
      for (const entry of pending) ringPush(entry.frame);
      pending = null;
      pendingPreroll = [];
    }

    ringPush(frame);
    return results;
  }

  function flush(): SpeechSegment | null {
    if (mode === "open") {
      const entries = openEntries;
      openEntries = [];
      mode = "idle";
      return finalizeAsSegment(entries, "flush");
    }
    if (pending !== null) {
      const entries: SegmentEntry[] = [
        ...pendingPreroll.map((f) => ({ frame: f, isSpeech: false })),
        ...pending,
      ];
      pending = null;
      pendingPreroll = [];
      return finalizeAsSegment(entries, "flush");
    }
    return null;
  }

  return {
    push,
    flush,
    msSinceSpeech: () => msSinceSpeechCount,
  };
}
