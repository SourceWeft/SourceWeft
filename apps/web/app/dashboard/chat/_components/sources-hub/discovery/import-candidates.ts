export type ImportOutcome =
  | { url: string; kind: "indexed"; sourceId: string }
  | { url: string; kind: "existing"; sourceId: string }
  | { url: string; kind: "failed"; message: string; sourceId?: string }
  /** Not sent: an earlier page already ran out of ingestion pages. */
  | { url: string; kind: "quota" }
  /** Added, but still being read when the wait ended. */
  | { url: string; kind: "pending"; sourceId: string };

export type CreatedSource = { id: string; alreadyExisted?: boolean };

export type SourceStatusItem = {
  id: string;
  status: string;
  error: string | null;
  errorCode?: string | null;
};

export const QUOTA_ERROR_CODE = "PAGES_LIMIT_EXCEEDED";

type Ports = {
  create: (url: string) => Promise<CreatedSource>;
  statuses: (ids: string[]) => Promise<SourceStatusItem[]>;
  sleep?: (ms: number) => Promise<void>;
};

function describe(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isQuota(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === QUOTA_ERROR_CODE
  );
}

/**
 * Imports the chosen pages as URL sources, a few at a time. Each page keeps
 * its own result; one failing never stops the others. The exception is
 * running out of ingestion pages: a page's cost is only known once it has
 * been read, so the import goes in small waves and, as soon as one page is
 * refused for pages, stops sending the rest and reports them as not imported.
 */
export async function importCandidates(
  input: {
    urls: readonly string[];
    concurrency?: number;
    pollIntervalMs?: number;
    maxPolls?: number;
    onOutcome?: (outcome: ImportOutcome) => void;
  } & Ports,
): Promise<ImportOutcome[]> {
  const concurrency = Math.max(1, input.concurrency ?? 3);
  const pollIntervalMs = input.pollIntervalMs ?? 2_000;
  const maxPolls = input.maxPolls ?? 45;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const outcomes: ImportOutcome[] = [];
  const record = (outcome: ImportOutcome) => {
    outcomes.push(outcome);
    input.onOutcome?.(outcome);
  };

  let outOfPages = false;
  for (let start = 0; start < input.urls.length; start += concurrency) {
    const wave = input.urls.slice(start, start + concurrency);
    if (outOfPages) {
      for (const url of wave) record({ url, kind: "quota" });
      continue;
    }

    const created = await Promise.all(
      wave.map(async (url) => {
        try {
          return { url, source: await input.create(url) };
        } catch (error) {
          return { url, error };
        }
      }),
    );

    const waiting = new Map<string, string>();
    for (const item of created) {
      if ("error" in item) {
        if (isQuota(item.error)) {
          outOfPages = true;
          record({ url: item.url, kind: "quota" });
        } else {
          record({
            url: item.url,
            kind: "failed",
            message: describe(item.error, "The page could not be added."),
          });
        }
      } else if (item.source.alreadyExisted) {
        record({ url: item.url, kind: "existing", sourceId: item.source.id });
      } else {
        waiting.set(item.source.id, item.url);
      }
    }

    for (let poll = 0; waiting.size > 0 && poll < maxPolls; poll += 1) {
      if (poll > 0) await sleep(pollIntervalMs);
      let items: SourceStatusItem[];
      try {
        items = await input.statuses([...waiting.keys()]);
      } catch {
        continue;
      }
      for (const item of items) {
        const url = waiting.get(item.id);
        if (!url) continue;
        if (item.status === "indexed") {
          waiting.delete(item.id);
          record({ url, kind: "indexed", sourceId: item.id });
        } else if (item.status === "failed") {
          waiting.delete(item.id);
          if (item.errorCode === QUOTA_ERROR_CODE) {
            outOfPages = true;
            record({ url, kind: "quota" });
          } else {
            record({
              url,
              kind: "failed",
              message: item.error ?? "The page could not be read.",
              sourceId: item.id,
            });
          }
        }
      }
    }
    for (const [sourceId, url] of waiting) {
      record({ url, kind: "pending", sourceId });
    }
  }
  return outcomes;
}
