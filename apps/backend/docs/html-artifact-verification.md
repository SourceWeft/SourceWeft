# HTML artifact implementation verification

Development baseline: `8fdb8144` (main). Implementation branch: `codex/html-artifact-v4`. Work is isolated in a Git worktree; no deployment or merge into main was performed.

## Checks executed locally

| Area                                                              | Result                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Contracts                                                         | 123 tests passed                                                                                                                  |
| Generic publisher and HTML visual-review tool                     | 100 Vitest tests + 2 manifest tests passed                                                                                        |
| Artifact tool registry                                            | 11 tests passed                                                                                                                   |
| Existing PPTX skill                                               | 15 tests passed                                                                                                                   |
| Sandbox tools                                                     | 120 passed, 1 skipped by the existing suite                                                                                       |
| Backend artifact / sharing / staging / database checks            | 112 passed; database tests use temporary isolated PostgreSQL databases with full migrations                                       |
| Web proxy, URL adapters, shared viewer                            | 33 tests passed                                                                                                                   |
| Web lint / type checks                                            | Passed                                                                                                                            |
| Publisher, contracts, registry and backend production type checks | Passed                                                                                                                            |
| Complete backend type check including unrelated tests             | Still fails at the same three pre-existing `sources/parsers/parsers.test.ts` errors (592, 599, 601), reproduced on unchanged main |

The full library runner exercises all 36 themes, 31 layouts, 27 animations and 20 FX. Animation fixtures include actual paths, lists and hover targets; applied class names alone do not count as animation coverage. Browser checks cover the final bytes, embedded fonts, layout, screenshots and disposal. Generated local evidence is under `output/html-library/`.

Three ordinary page fixtures cover a report, landing page and interactive visualization at 1440×900, 768×1024 and 390×844. The landing page asserts a local form result; the visualization asserts slider/keyboard updates and reset behavior. Evidence is under `output/html-pages/`.

The behavior runner checks 16:9 and 4:3 in Chromium 147.0.7727.15, Firefox 148.0.2 and WebKit 26.4, including fragments, overview/FX restoration, local-file use, and editing the third page while preserving stable IDs. Firefox/WebKit HTTP tests use pre-navigation request interception because their drivers do not support the same synthetic offline navigation as Chromium. WebKit also requires interception for local-file navigation. The report records each strategy instead of claiming all native offline flags passed.

A real browser run of the shared React viewer additionally checked a non-Reveal producer, rejected a forged parent-window state message, verified next-page synchronization, entered/exited native fullscreen, copied source, downloaded the original HTML, and exercised a no-protocol page. Evidence and the disposable harness live under `output/playwright/` and the publisher's browser fixtures.

## Delivery E2E — 2026-09-08

A fixed three-page Chinese presentation passed the real delivery path: skill build and final-file QA → `publish_artifact` invocation → migrated isolated PostgreSQL and the configured R2 object store → the application's Next.js share page → browser download. The test supplied local fixture bytes through the sandbox file port; it did not run a provider sandbox or a model-generated conversation.

The browser run checked source preview, all three thumbnail images, next-page and fragment controls, thumbnail page jumps, overview, and native fullscreen entry/exit. The downloaded 1,106,546-byte HTML matched the published and QA bytes: `sha256:150bd412a819fb4440f5f1535d954957dc96d559637db895a52f6278f58f5960`. Publication of a second version retained the first version's exact bytes; stale writes, stale shared-version URLs, and unauthenticated private-file reads were rejected.

This E2E found a real embedding defect: Reveal's embedded mode does not set the full-page document height, so the generated document collapsed to zero height inside the viewer iframe. The skill builder now supplies explicit document dimensions. The shared viewer remains independent of Reveal. The behavior runner now checks sandboxed iframe dimensions, resizing and navigation in all three engines and both aspect ratios, in addition to its standalone and revision checks. All seven behavior cases passed, and the two skill catalog/bundle tests passed. The catalog test executes effect registration instead of asserting one JavaScript quote style.

The application screenshots were captured with Playwright CLI Chromium 152.0.7977.82 at 1440×1000. The pinned runtime regression still uses Chromium 147.0.7727.15, Firefox 148.0.2 and WebKit 26.4. Next.js used file polling for this isolated development process after native file watching hit macOS `EMFILE`; the compiler and application code were unchanged. Evidence, screenshots and the downloaded HTML are under `output/playwright/html-e2e/`. No paid model visual review was invoked.

## Remaining release checks

- Rebuild and verify the changed Daytona/Cloudflare sandbox images before enabling these generating skills in a deployment. Docker build definitions and runtime pins were updated, but new sandbox images were not deployed in this task.
- Safari device testing is not claimed by WebKit automation.
- No paid live vision-model review was invoked during development. The shared tool's configuration/error/completeness behavior is unit-tested; production generating skills require actual successful visual review before publishing.
- The unrelated main-branch type errors remain visible and were not bypassed or changed to make the branch appear clean.
