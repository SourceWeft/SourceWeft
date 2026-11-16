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

function retryAfterSecondsOf(error: HttpClientError): number | undefined {
  const value = error.details?.retryAfterSeconds;
  return typeof value === "number" ? value : undefined;
}

/**
 * Sends one segment through the content client and turns its HTTP error into
 * the {@link SegmentSendError} the transport understands. Errors are classified
 * by status only, never by their message text.
 */
async function sendSegment(
  workspaceId: string,
  sessionId: string,
  seq: number,
  wav: Uint8Array,
  signal: AbortSignal,
): Promise<{ text: string }> {
  try {
    const result = await contentClient.transcribeDictationSegment(workspaceId, {
      sessionId,
      seq,
      wav,
      signal,
    });
    return { text: result.text };
  } catch (error) {
    if (error instanceof HttpClientError) {
      throw new SegmentSendError(error.status, retryAfterSecondsOf(error));
    }
    throw new SegmentSendError(null);
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
  if (sessionRef.current === null) {
    sessionRef.current = createDictationSession({
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
    });
  }

  useEffect(() => {
    const session = sessionRef.current;
    return () => session?.dispose();
  }, []);

  const subscribe = useCallback(
    (listener: () => void) => sessionRef.current!.subscribe(listener),
    [],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => sessionRef.current!.snapshot(),
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
    const session = sessionRef.current!;
    const status = session.snapshot().status;
    if (status === "listening" || status === "starting") {
      void session.stop();
    } else {
      void session.start();
    }
  }, []);

  const stop = useCallback(() => sessionRef.current!.stop(), []);

  const active =
    snapshot.status === "listening" || snapshot.status === "finishing";

  return { visible, snapshot, toggle, stop, active };
}
