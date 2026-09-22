# Skill analysis evaluation

Run from `apps/backend` with the deployment database, gateway credentials, and overview billing configured. No substitute model or synthetic human labels are supported.

```sh
pnpm exec tsx scripts/evaluate-skill-analysis.ts --export /tmp/skill-review.json --count 100
# Humans read each raw skillMd and files and set expectedPrimary plus reviewedBy.
pnpm exec tsx scripts/evaluate-skill-analysis.ts --run /tmp/skill-review.json --output /tmp/skill-report.json
# Recompute and explicitly record only a passing report:
pnpm exec tsx scripts/evaluate-skill-analysis.ts --run /tmp/skill-review.json --output /tmp/skill-approved-report.json --record-quality
```

Export selects current published public registry skills, removes identical source copies, and round-robins keyword baseline categories. It fails if fewer than the requested 100–1000 distinct sources exist. Labels and reviewers start null; never substitute model labels, existing categories, or keyword guesses for human review. Export and review again after prompt or taxonomy changes. Output files must not already exist.

The run invokes the same configured default chat gateway and billed subject as production overviews, sequentially with production token and timeout bounds. It validates localized output and evidence against original SKILL.md and excerpts actually sent. It never writes overviews or categories. Model calls incur normal billing and associated billing/telemetry writes; export is database read-only. Only explicit `--record-quality` writes the evaluation setting, after recomputing a passing report.

Reports include dataset hash, versions, allowlisted model/configuration identity, actual model per successful call, billing subject, predictions, labels, baseline, safe errors, timings, coverage and per-category accuracy. Cost is null because the model-call interface does not expose settled cost. Credentials and raw provider errors are excluded.

Errors and abstentions count as incorrect. Unlabeled cases are excluded from accuracy but prevent approval; missing reviewers also prevent approval. Passing requires every case reviewed, at least 100 unique skills/sources, at least 90% accuracy, and at least 10 percentage points improvement over the name/description keyword baseline. Implementation tests do not constitute human review or a real model evaluation. Those remain required before bulk legacy migration.
