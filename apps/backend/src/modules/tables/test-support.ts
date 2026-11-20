import {
  newTableColumnId,
  newTableRowId,
  tableCellFingerprint,
  tableColumnFingerprint,
  type TableColumnInput,
  type TableContent,
} from "@sourceweft/contracts/table";

/** One source as a stored row refers to it. */
export type FixtureSource = {
  sourceId: string;
  documentId: string;
  contentHash: string;
  title?: string;
};

/**
 * A valid stored table: one `found` cell per source and column, built from the
 * contract's own fingerprints. The recipe names exactly these sources and
 * columns, with the column ids a regeneration keeps.
 */
export function tableContentFixture(input: {
  sources: FixtureSource[];
  columns?: TableColumnInput[];
  language?: string;
  instruction?: string;
}): TableContent {
  const inputs: TableColumnInput[] = input.columns ?? [
    { name: "Design", description: "Study design", type: "text" },
    { name: "Participants", type: "number" },
  ];
  const columns = inputs.map((column) => ({
    id: column.id ?? newTableColumnId(),
    name: column.name,
    ...(column.description ? { description: column.description } : {}),
    type: column.type,
    fingerprint: tableColumnFingerprint(column),
  }));
  const language = input.language ?? "en";
  return {
    schemaVersion: 1,
    kind: "table",
    language,
    columns,
    rows: input.sources.map((source) => ({
      id: newTableRowId(),
      sourceId: source.sourceId,
      documentId: source.documentId,
      title: source.title ?? "Source",
      contentHash: source.contentHash,
      status: "ok" as const,
      cells: Object.fromEntries(
        columns.map((column) => [
          column.id,
          {
            status: "found" as const,
            value: "randomised",
            evidence: [
              {
                kind: "chunk" as const,
                sourceId: source.sourceId,
                documentId: source.documentId,
                chunkId: "chk",
                quote: "a randomised trial",
                quoteHash: `sha256:${"a".repeat(64)}`,
              },
            ],
            fingerprint: tableCellFingerprint({
              columnFingerprint: column.fingerprint,
              contentHash: source.contentHash,
              promptVersion: "table-v1",
              language,
            }),
          },
        ]),
      ),
    })),
    generation: {
      promptVersion: "table-v1",
      modelAlias: "test-model",
      stats: {
        sources: input.sources.length,
        columns: columns.length,
        found: input.sources.length * columns.length,
        notFound: 0,
        unverified: 0,
        reusedCells: 0,
        failedRows: 0,
        skippedRows: 0,
        modelCalls: input.sources.length,
        tokensEstimated: 100,
      },
      recipe: {
        ...(input.instruction ? { instruction: input.instruction } : {}),
        columns: columns.map(({ id, name, description, type }) => ({
          id,
          name,
          ...(description ? { description } : {}),
          type,
        })),
        sourceIds: input.sources.map((source) => source.sourceId),
      },
    },
  };
}
