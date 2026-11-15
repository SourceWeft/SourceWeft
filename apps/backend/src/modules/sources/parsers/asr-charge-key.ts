/**
 * The ledger key for the transcription's credit charge.
 *
 * The parse job's own key also identifies the page charge written when the
 * source finishes indexing, and a team's ledger holds one row per key. Sharing
 * it made the page charge collide with the transcription charge, which failed
 * every audio source after it had been transcribed and billed.
 */
export function asrChargeIdempotencyKey(input: {
  idempotencyKey?: string;
  sourceId?: string;
  fileName: string;
  fileSize: number;
}): string {
  const parseKey = input.idempotencyKey?.trim();
  if (parseKey) {
    return `${parseKey}:asr`;
  }
  // Pinned verbatim: transcriptions already metered under this key must not
  // be charged again.
  return `source-asr:${input.sourceId ?? input.fileName}:${input.fileSize}:credits`;
}
