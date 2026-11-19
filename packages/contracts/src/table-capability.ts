import {
  GroundedGenerationError,
  isGroundedGenerationError,
  type GroundedAnchorPort,
  type GroundedCheckpointStore,
  type GroundedCorpusChunk,
  type GroundedModelPort,
} from "./grounded-generation";
import type {
  TableColumn,
  TableColumnInput,
  TableContent,
  TableRow,
  TableStats,
} from "./table";

/**
 * The host ↔ table capability contract.
 *
 * The backend never imports `@sourceweft/builtin-tool-table`. It loads the
 * package's entry module through `@sourceweft/agent-tool-registry/server`, calls
 * the `createTableCapability` factory and narrows the result with
 * `readTableCapability`. The shapes both sides agree on live here, beside the
 * table content contract they are built from (`./table`); they are types plus
 * one pure error class, so nothing here pulls server code into a browser graph.
 *
 * The module is a set of optional groups. Each host that needs a group asks
 * for it by name and fails loudly if it is missing.
 */

/* ------------------------------------------------------------------ errors */

/** The same class and check as every grounded artifact type. */
export const TableGenerationError = GroundedGenerationError;
export type TableGenerationError = GroundedGenerationError;
export const isTableGenerationError = isGroundedGenerationError;

/* ------------------------------------------------------------------- ports */

export type TableOperation = "table.columns.suggest" | "table.fill" | "table.merge";

/** One structured-output call on the default chat model, billed by the host. */
export type TableModelPort = GroundedModelPort<TableOperation>;

/**
 * Whether every figure in a claim also appears in a passage, however it is
 * written there (`1,200`, `1.2k`, full-width digits). The host supplies it so
 * the engine stays free of locale data.
 */
export interface TableFigurePort {
  covered(claim: string, passage: string): boolean;
}

/**
 * The engine's resume state: the rows finished so far, by source id. The host
 * stores it as JSON and hands it back unchanged.
 */
export type TableCheckpoint = {
  versionNo: number;
  rows: Record<string /* sourceId */, TableRow>;
};

/* ------------------------------------------------------------- generation */

/** A source as the host loads it. */
export type TableSourceInput = {
  sourceId: string;
  documentId: string;
  title: string;
  contentHash: string;
  /** False while the source is not indexed; its row is `skipped`. */
  indexed: boolean;
  chunks: GroundedCorpusChunk[];
};

export type FillTableInput = {
  artifactId: string;
  versionNo: number;
  columns: TableColumn[];
  sources: TableSourceInput[];
  /** BCP 47 tag of the output. */
  language: string;
  /** The user's own instruction; never source text. */
  instruction?: string;
  modelAlias: string;
  /** The previous version, whose unchanged cells are reused. */
  previous?: TableContent;
  /** Stored with the version for "adjust and regenerate". */
  recipe: TableContent["generation"]["recipe"];
};

export type FillTableDeps = {
  model: TableModelPort;
  anchor: GroundedAnchorPort;
  figures: TableFigurePort;
  onProgress?(progress: {
    stage: "fill" | "finalize";
    done: number;
    total: number;
  }): void | Promise<void>;
  checkpoint?: GroundedCheckpointStore<TableCheckpoint>;
  signal?: AbortSignal;
};

/** What a fill would cost, computed without any model call. */
export type TableFillPlan = {
  calls: number;
  reusedCells: number;
  cellsToFill: number;
  totalTokens: number;
  exceedsLimit: boolean;
};

export type TableGenerationMembers = {
  suggestColumns(
    deps: { model: TableModelPort },
    input: {
      referenceId: string;
      idempotencyKey: string;
      instruction?: string;
      language: string;
      sources: { title: string; summary: string }[];
    },
  ): Promise<TableColumnInput[]>;
  /** Gives each column its id (kept from `previous` when it has one) and fingerprint. */
  resolveColumns(input: TableColumnInput[], previous?: TableColumn[]): TableColumn[];
  planFill(
    input: Pick<FillTableInput, "columns" | "sources" | "language" | "previous">,
  ): TableFillPlan;
  fillTable(
    deps: FillTableDeps,
    input: FillTableInput,
  ): Promise<{ content: TableContent; stats: TableStats }>;
  limits: {
    maxTotalInputTokens: number;
    /** Wall-clock budget of one generation job. */
    jobTimeoutMs: number;
  };
};

/* ------------------------------------------------------------------ module */

/**
 * Everything the table capability offers a host. Groups are optional so each
 * can ship on its own; a host requires the ones it uses.
 */
export type TableCapabilityModule = {
  generation?: TableGenerationMembers;
};

/** Name of the entry-module factory that builds the module. */
export const TABLE_CAPABILITY_FACTORY = "createTableCapability";

export type CreateTableCapability = () => TableCapabilityModule;

/** The capability is not deployed as this host expects. Never retried away. */
export class TableCapabilityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableCapabilityUnavailableError";
  }
}

const REQUIRED_MEMBERS: {
  [Group in keyof Required<TableCapabilityModule>]: readonly string[];
} = {
  generation: ["suggestColumns", "resolveColumns", "planFill", "fillTable", "limits"],
};

/**
 * Narrows a loaded entry module to the table capability. With `require`, the
 * named groups must be present with every member, or this throws
 * `TableCapabilityUnavailableError` naming what is missing.
 */
export function readTableCapability(
  entryModule: Record<string, unknown> | null | undefined,
  ...require: (keyof TableCapabilityModule)[]
): TableCapabilityModule {
  const factory = entryModule?.[TABLE_CAPABILITY_FACTORY];
  if (typeof factory !== "function") {
    throw new TableCapabilityUnavailableError(
      `The table capability entry module does not export ${TABLE_CAPABILITY_FACTORY}()`,
    );
  }
  const capability = (factory as CreateTableCapability)();
  if (!capability || typeof capability !== "object") {
    throw new TableCapabilityUnavailableError(
      `${TABLE_CAPABILITY_FACTORY}() did not return a table capability module`,
    );
  }
  for (const group of require) {
    const members = capability[group] as Record<string, unknown> | undefined;
    if (!members || typeof members !== "object") {
      throw new TableCapabilityUnavailableError(
        `The table capability does not provide its "${group}" members`,
      );
    }
    const missing = REQUIRED_MEMBERS[group].filter(
      (name) => members[name] === undefined,
    );
    if (missing.length > 0) {
      throw new TableCapabilityUnavailableError(
        `The table capability's "${group}" members lack ${missing.join(", ")}`,
      );
    }
  }
  return capability;
}
