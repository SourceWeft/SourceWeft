export function assertSourceScope(
  rows: readonly { sourceId: string }[],
  sourceIds: readonly string[],
): void {
  const allowed = new Set(sourceIds);
  if (rows.some((row) => !allowed.has(row.sourceId))) {
    throw new Error("RETRIEVAL_SCOPE_VIOLATION");
  }
}

export function assertDocumentScope(
  rows: readonly { sourceId: string; documentId: string }[],
  document: { sourceId: string; documentId: string },
): void {
  if (
    rows.some(
      (row) =>
        row.sourceId !== document.sourceId ||
        row.documentId !== document.documentId,
    )
  ) {
    throw new Error("RETRIEVAL_DOCUMENT_SCOPE_VIOLATION");
  }
}
