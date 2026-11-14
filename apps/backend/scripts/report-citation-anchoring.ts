import "dotenv/config";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

/**
 * How cross-language citation anchoring behaves on real conversations (#516).
 * Read-only: it never writes to the database.
 *
 *   pnpm exec tsx scripts/report-citation-anchoring.ts [--days 7]
 *
 * `--days` defaults to 7 (and to all history for an export). Prints counts and shares by method, script pair and by-meaning outcome, how
 * many decisions sit within +/-0.05 of a threshold, the second pass's
 * embedding latency and failure rate, and a per-day trend. The numbers come
 * from `citations.metadata_json.anchoring` and the LLM observability tables;
 * no message or passage text is read.
 *
 * Calibration (for the deployment owner, on their own data; the files hold
 * USER CONTENT and may only be written to git-ignored paths):
 *
 *   --export-borderline N   write the N decisions nearest a threshold, with the
 *                           claim sentence and cited passage, for labelling
 *   --out <file>            where to write it (default .local-eval/...)
 *   --import-labels <file>  merge the labelled cases of an export into the
 *                           labelled set that `eval-citation-anchoring.ts
 *                           --labels` reads
 *
 * Label a case by setting its "label" to "supported" or "not".
 */
const root = resolve(import.meta.dirname, "../../..");
const defaults = {
  export: resolve(root, ".local-eval/citation-anchoring-borderline.jsonl"),
  labelled: resolve(root, ".local-eval/citation-anchoring-labelled.jsonl"),
};

const { values } = parseArgs({
  options: {
    days: { type: "string" },
    "export-borderline": { type: "string" },
    out: { type: "string" },
    "import-labels": { type: "string" },
    "labelled-file": { type: "string" },
  },
});

const days = values.days === undefined ? undefined : Number(values.days);
if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
  throw new Error("--days must be a positive number");
}

const { closeDatabase } = await import("@sourceweft/db");
try {
  if (values["import-labels"]) {
    const { importLabels } =
      await import("../src/modules/citations/anchoring-labels");
    const result = await importLabels({
      from: resolve(values["import-labels"]),
      into: resolve(values["labelled-file"] ?? defaults.labelled),
    });
    console.log(
      `Imported ${result.imported} labelled case(s); ${result.unlabelled} unlabelled left out; ${result.total} in the labelled set.`,
    );
  } else if (values["export-borderline"]) {
    const count = Number(values["export-borderline"]);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(
        "--export-borderline needs a whole number of cases, 1 or more",
      );
    }
    const { findBorderlineCases, writeBorderlineExport, USER_CONTENT_WARNING } =
      await import("../src/modules/citations/anchoring-calibration");
    console.error(USER_CONTENT_WARNING);
    const out = resolve(values.out ?? defaults.export);
    // Check the destination first so nothing is read or written for a bad path.
    const { assertGitIgnored } = await import("../src/shared/git-ignore");
    await assertGitIgnored(out);
    const { cases, skipped } = await findBorderlineCases({
      limit: count,
      ...(days === undefined ? {} : { days }),
    });
    await writeBorderlineExport(out, cases);
    console.log(
      `Wrote ${cases.length} case(s) to ${out} (${skipped} skipped: claim or passage no longer available).`,
    );
  } else {
    const { loadAnchoringReport, formatAnchoringReport } =
      await import("../src/modules/citations/anchoring-report");
    console.log(
      formatAnchoringReport(await loadAnchoringReport({ days: days ?? 7 })),
    );
  }
} finally {
  await closeDatabase();
}
