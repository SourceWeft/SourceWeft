"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { HttpClientError } from "@sourceweft/sdk";
import {
  isPcmCaptureSupported,
  startPcmCapture,
} from "@sourceweft/ui-web/lib/audio/pcm-capture";
import { createSpeechSegmenter } from "@sourceweft/ui-web/lib/audio/speech-segmenter";
import { usePromptInputController } from "@sourceweft/ui-web/components/ai-elements/prompt-input";

import { useNativeHost } from "@/lib/native-host";
import { contentClient } from "@/lib/sdk";

import {
  createDictationSession,
  type DictationSession,
  type DictationSnapshot,
} from "./dictation-session";
import { SegmentSendError } from "./segment-transport";

const IDLE_SNAPSHOT: DictationSnapshot = { status: "idle", notice: null };

// A segment request that never answers would keep "Transcribing…" and hold send
// forever, so each one is given its own deadline: the request is aborted and
// surfaced to the transport as a network failure, which applies its one retry.
export const SEGMENT_REQUEST_TIMEOUT_MS = 30_000;

function retryAfterSecondsOf(error: HttpClientError): number | undefined {
  const value = error.details?.retryAfterSeconds;
  return typeof value === "number" ? value : undefined;
}

/**
 * Sends one segment through the content client and turns its HTTP error into
 * the {@link SegmentSendError} the transport understands. Errors are classified
 * by status only, never by their message text. A request that does not answer
 * within {@link SEGMENT_REQUEST_TIMEOUT_MS} is aborted and reported as a
 * network failure (`SegmentSendError(null)`), so the transport retries it once.
 */
export async function sendSegment(
  workspaceId: string,
  sessionId: string,
  seq: number,
  wav: Uint8Array,
  signal: AbortSignal,
): Promise<{ text: string }> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SEGMENT_REQUEST_TIMEOUT_MS);

  try {
    const result = await contentClient.transcribeDictationSegment(workspaceId, {
      sessionId,
      seq,
      wav,
      signal: controller.signal,
    });
    return { text: result.text };
  } catch (error) {
    if (timedOut) {
      throw new SegmentSendError(null);
    }
    if (error instanceof HttpClientError) {
      throw new SegmentSendError(error.status, retryAfterSecondsOf(error));
    }
    throw new SegmentSendError(null);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abortFromCaller);
  }
}

export type UseDictation = {
  /** Available for this workspace, supported by the client, and not on mobile. */
  visible: boolean;
  snapshot: DictationSnapshot;
  toggle(): void;
  stop(): Promise<void>;
  /** Listening or finishing: a send in progress should stop, not submit. */
  active: boolean;
};

export function useDictation(input: {
  workspaceId: string | null | undefined;
}): UseDictation {
  const workspaceId = input.workspaceId ?? null;
  const host = useNativeHost();
  const controller = usePromptInputController();
  // insertText is stable; the controller object is rebuilt on every keystroke,
  // so it must never land in a dependency list — only insertText is taken out.
  const insertText = controller.insertText;
  const insertTextRef = useRef(insertText);
  insertTextRef.current = insertText;
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  const sessionRef = useRef<DictationSession | null>(null);

  const createSession = useCallback(
    () =>
      createDictationSession({
        startCapture: startPcmCapture,
        createSegmenter: createSpeechSegmenter,
        send: (wav, seq, sessionId, signal) => {
          const id = workspaceIdRef.current;
          if (!id) {
            return Promise.reject(new SegmentSendError(null));
          }
          return sendSegment(id, sessionId, seq, wav, signal);
        },
        insertText: (text) => insertTextRef.current(text),
      }),
    [],
  );

  // Returns the live session, building a fresh one whenever the previous was
  // disposed by an effect cleanup. StrictMode mounts, cleans up, then mounts
  // again; without this the disposed session would be reused and `start()`
  // would return at its `disposed` check forever.
  const ensureSession = useCallback((): DictationSession => {
    const existing = sessionRef.current;
    if (existing && !existing.isDisposed()) {
      return existing;
    }
    const next = createSession();
    sessionRef.current = next;
    return next;
  }, [createSession]);

  if (sessionRef.current === null) {
    sessionRef.current = createSession();
  }

  useEffect(() => {
    const session = ensureSession();
    return () => {
      session.dispose();
      // Drop the disposed session so the next render builds a new one.
      if (sessionRef.current === session) {
        sessionRef.current = null;
      }
    };
  }, [ensureSession]);

  const subscribe = useCallback(
    (listener: () => void) => ensureSession().subscribe(listener),
    [ensureSession],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => ensureSession().snapshot(),
    () => IDLE_SNAPSHOT,
  );

  // Availability is read once per workspace id; a failed read means hidden and
  // is not retried.
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!workspaceId) {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    setAvailable(false);
    void contentClient.getDictationAvailability(workspaceId).then(
      (result) => {
        if (!cancelled) {
          setAvailable(result.available);
        }
      },
      () => {
        if (!cancelled) {
          setAvailable(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // getUserMedia/AudioWorklet support is only knowable in the browser.
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(isPcmCaptureSupported());
  }, []);

  const visible =
    available &&
    supported &&
    host.kind !== "mobile" &&
    host.kind !== "unknown";

  const toggle = useCallback(() => {
    const session = ensureSession();
    const status = session.snapshot().status;
    if (status === "listening" || status === "starting") {
      void session.stop();
    } else {
      void session.start();
    }
  }, [ensureSession]);

  const stop = useCallback(() => ensureSession().stop(), [ensureSession]);

  const active =
    snapshot.status === "listening" || snapshot.status === "finishing";

  // While dictation is active, Escape stops it wherever focus is on the page
  // (the microphone button, for one, is not inside the editor). The editor's
  // own Escape handler runs first and marks the event handled, so an Escape in
  // the editor is not acted on twice. No listener exists when inactive, so
  // Escape for edit-mode cancel, dialogs and menus is untouched.
  useEffect(() => {
    if (!active) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        void ensureSession().stop();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [active, ensureSession]);

  return { visible, snapshot, toggle, stop, active };
}
