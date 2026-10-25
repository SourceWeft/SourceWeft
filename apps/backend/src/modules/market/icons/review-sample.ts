import type { IconCandidatesRecord, IconDecision } from "./dry-run-types";
import { decisionDiffers } from "./decision";

/**
 * The review sample of the icon dry-run (Issue #367): from the entries whose
 * decision differs from the icon the pages show today, a random sample
 * stratified by the decision's source, rendered as a page with the old and the
 * new image side by side. A person reviews it — the target before any display
 * switch is ≥ 98% observed correct and no wrong-company assignment. Pure; the
 * script (`scripts/icon-dry-run-report.ts`) reads the database and writes the
 * file.
 */

export type ReviewRow = {
  identifier: string;
  version: string;
  decision: IconDecision;
  candidates?: IconCandidatesRecord;
};

/** The stratum a decision falls in: the source it picks, else the placeholder. */
export function stratumOf(decision: IconDecision) {
  return decision.pick?.source ?? "placeholder";
}

/** mulberry32: a small seeded generator, so a sample can be reproduced. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], next: () => number) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export type ReviewSummary = {
  entriesWithDecision: number;
  differing: number;
  byStratum: Record<string, number>;
  sampled: Record<string, number>;
  withDisagreement: number;
};

/**
 * `size` rows of those that differ, each stratum getting an equal share first
 * (or all it has) and the rest shared in proportion to what remains, drawn at
 * random with `seed`.
 */
export function selectReviewSample(
  rows: readonly ReviewRow[],
  options: { size: number; seed: number },
): { sample: ReviewRow[]; summary: ReviewSummary } {
  const next = random(options.seed);
  const differing = rows.filter((row) => decisionDiffers(row.decision));
  const strata = new Map<string, ReviewRow[]>();
  for (const row of differing) {
    const key = stratumOf(row.decision);
    strata.set(key, [...(strata.get(key) ?? []), row]);
  }
  const keys = [...strata.keys()].sort();
  const quota = new Map<string, number>();
  const equalShare = keys.length ? Math.floor(options.size / keys.length) : 0;
  let used = 0;
  for (const key of keys) {
    const n = Math.min(strata.get(key)!.length, equalShare);
    quota.set(key, n);
    used += n;
  }
  // Share what is left among the strata that still have rows, largest first.
  let left = Math.min(options.size, differing.length) - used;
  while (left > 0) {
    const open = keys
      .filter((key) => quota.get(key)! < strata.get(key)!.length)
      .sort(
        (a, b) =>
          strata.get(b)!.length - quota.get(b)! - (strata.get(a)!.length - quota.get(a)!),
      );
    if (open.length === 0) break;
    for (const key of open) {
      if (left === 0) break;
      quota.set(key, quota.get(key)! + 1);
      left -= 1;
    }
  }
  const sample: ReviewRow[] = [];
  const sampled: Record<string, number> = {};
  for (const key of keys) {
    const picked = shuffled(strata.get(key)!, next).slice(0, quota.get(key)!);
    sampled[key] = picked.length;
    sample.push(...picked);
  }
  return {
    sample: shuffled(sample, next),
    summary: {
      entriesWithDecision: rows.length,
      differing: differing.length,
      byStratum: Object.fromEntries(keys.map((k) => [k, strata.get(k)!.length])),
      sampled,
      withDisagreement: differing.filter((row) => row.decision.disagreement).length,
    },
  };
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

// Hosts an <img> may load from: GitHub's avatar hosts and our own stored
// copies. Any other address was supplied by a publisher; it is shown as a
// link, so opening this page never makes the reviewer's browser call it.
const IMAGE_HOSTS = new Set(["avatars.githubusercontent.com", "github.com"]);

function isTrustedImage(url: URL) {
  return IMAGE_HOSTS.has(url.hostname) || url.pathname.includes("/market/mcp-icons/");
}

function image(url: string | undefined) {
  if (!url) return "<em>letter placeholder</em>";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "<em>not shown</em>";
  }
  if (parsed.protocol !== "https:") return "<em>not shown</em>";
  const safe = escapeHtml(url);
  if (!isTrustedImage(parsed)) {
    return `<a href="${safe}" rel="noreferrer noopener">${escapeHtml(parsed.hostname)}</a>`;
  }
  return `<a href="${safe}" rel="noreferrer noopener"><img src="${safe}" width="64" height="64" loading="lazy" referrerpolicy="no-referrer" alt=""></a>`;
}

/** The review page: one row per sampled entry, old and new image side by side. */
export function renderReviewHtml(
  sample: readonly ReviewRow[],
  summary: ReviewSummary,
  generatedAt: Date,
) {
  const rows = sample
    .map((row, index) => {
      const { decision } = row;
      const candidates = (row.candidates?.items ?? [])
        .map((c) => {
          const status = c.rejection ? `rejected: ${c.rejection}` : "accepted";
          const signals = c.signals?.length ? ` [${c.signals.join(", ")}]` : "";
          return `${c.source}${c.kind ? `/${c.kind}` : ""} · tier ${c.tier} · ${status}${signals}`;
        })
        .map(escapeHtml)
        .join("<br>");
      return `<tr>
<td>${index + 1}</td>
<td><strong>${escapeHtml(row.identifier)}</strong><br><small>${escapeHtml(row.version)}</small></td>
<td>${escapeHtml(stratumOf(decision))}<br><small>${decision.pick ? `tier ${decision.pick.tier}` : escapeHtml(decision.reasons.join(", "))}${decision.disagreement ? "<br>DISAGREEMENT" : ""}</small></td>
<td>${escapeHtml(decision.site.tier)}<br><small>${escapeHtml([decision.site.domain, ...decision.site.reasons].filter(Boolean).join(" · "))}</small></td>
<td>${image(decision.current.iconUrl)}<br><small>${escapeHtml(decision.current.iconSource)}</small></td>
<td>${image(decision.pick?.storedUrl)}<br><small>${decision.pick ? `${decision.pick.width}×${decision.pick.height}` : ""}</small></td>
<td><small>${candidates}</small></td>
<td></td>
</tr>`;
    })
    .join("\n");
  return `<!doctype html>
<meta charset="utf-8">
<title>Icon dry-run review sample</title>
<style>
body{font:14px system-ui,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ccc;padding:6px;vertical-align:top;text-align:left}img{object-fit:contain;background:#eee}
</style>
<h1>Icon dry-run review sample</h1>
<p>Generated ${escapeHtml(generatedAt.toISOString())}. ${summary.differing} of ${summary.entriesWithDecision} decisions differ from today's icon; ${sample.length} sampled, stratified by the decision's source. Target before any display switch: at least 98% correct and no wrong-company assignment.</p>
<pre>${escapeHtml(JSON.stringify({ byStratum: summary.byStratum, sampled: summary.sampled, withDisagreement: summary.withDisagreement }, null, 2))}</pre>
<table>
<tr><th>#</th><th>Server</th><th>New rule picks</th><th>Site tier</th><th>Today</th><th>New</th><th>Candidates</th><th>Correct? (y / n / wrong company)</th></tr>
${rows}
</table>`;
}
