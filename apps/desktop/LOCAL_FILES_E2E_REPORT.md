# Local files real E2E — 2026-09-10

## Result

The real authenticated API → configured Agent/model → production Rust host →
macOS Seatbelt → physical files chain passed on `de007c64`, which includes the
local-directory implementation `383273f2`. A real browser then logged in through
the ordinary email/password form and verified the resulting PC conversation,
Files panel, external-edit preview, absence of Workfiles in the Hub, and offline
content removal. Browser login did not inject a session or mock backend results.

The native host used the existing real-host fixture for enrollment. Therefore
native UI enrollment and the OS directory picker are **not** covered. macOS native
UI actions became blocked when the computer locked. The in-app browser remained
usable independently and supplied the browser evidence below.

## Passed checks

1. Agent called write_file, edit_file, read_file and execute against one physical root.
2. BEFORE → AFTER edit was present in both input and command-created output files.
3. Command did not run before approval; the normal single-action approval and
   resume endpoints were used, without standing trust rules.
4. Exactly one native command invocation succeeded with exit code 0.
5. pwd returned the real bound directory; stdout included the expected marker.
6. PostgreSQL invocation result matched the native SQLite execution journal.
7. No prepare/collect tool was used and the conversation created zero DB Workfiles.
8. The live file endpoint listed the physical files and used Cache-Control: no-store.
9. An external disk edit was visible on the next API read and in the browser preview.
10. Binary download preserved bytes; binary text preview returned 415.
11. A path outside the bound directory was denied.
12. The PC Workfiles endpoint returned LOCAL_FILES_USE_DIRECTORY.
13. The browser displayed a distinct Files panel and no Workfiles tab in its Hub.
14. Stopping the native host caused DEVICE_OFFLINE; the browser removed the stale
    file list/preview and displayed the offline error, without a DB fallback.

## Evidence

- Thread: `b8913a7a-12b1-4f02-b23f-262b659e881a`.
- Device: `0c07783f-1ebd-49df-8ffd-bfc86cf7555d`.
- Marker: `LOCAL_FILES_REAL_E2E_00c64370`.
- Safe machine-checkable results: `output/playwright/local-files-e2e-20260910/`.
- Full private fixture/logs/source copy:
  `/private/tmp/sourceweft-files-e2e-20260910/`.
- Dedicated database: `sourceweft_local_pc_e2e_3a598ddc081b428e9bf41abae4569502`.
- Web/API: `localhost:3400` / `localhost:3401`; queue: `sourceweft-files-e2e`.
- No primary database data was copied into the fixture.

## Defects found and fixed in the working tree

- ICO entries advertised 32-bit pixels but embedded RGB PNGs. Next/Turbopack
  rejected favicon.ico and returned HTTP 500. The generator now emits RGBA ICO
  payloads; all four generated ICO files pass decoding/channel/opacity tests.
  The actual login page subsequently returned 200 and browser login succeeded.
- Physical read_file activity was classified as source content. Physical paths
  now use the Files scope and labels, while /kb and /workfiles keep their distinct
  semantics. Focused normalizer and Web display regressions passed. The updated
  trace label still needs a fresh Agent run on the latest test revision.
- The old execution bar wrapped its label vertically for long directory paths.
  While inspecting this, a newer main commit replaced the bar with Conversation
  details. No obsolete-bar patch was added back; latest UI verification is pending.

## Latest-main continuation and blockers

Main advanced to `044d73f8` during the run. This adds native access proofs, remote
connection policy and migration 0034, beyond a cosmetic UI change. The isolated
source copy was updated to that exact revision plus the ICO/file-label fixes,
0034 was applied only to the isolated database, UI packages and the real-host test
binary were rebuilt, and API/Web/worker were restarted.

The latest native-host startup was rejected by automatic approval review because
it would store test credentials in Keychain, authenticate a native session and
enable browser access to that test device. Review requires explicit user approval
for this security-sensitive permission and scope. A request has been presented;
that startup has not been executed or bypassed. Its runner is prepared at
`/private/tmp/sourceweft-files-e2e-20260910/e2e-context-host.mjs`.

Consequently, the passing results above must not be presented as complete E2E
acceptance of `044d73f8`. Remaining work: authorize the isolated device access,
run a browser-created PC task using the latest connection flow, verify the Files
scope on the new run, and test the native directory chooser once macOS is unlocked.

## Test setup corrections (not product failures)

The archived source initially lacked generated UI/market-contract files; these
were built using their existing scripts. Installed dependencies were cloned into
the copy after Turbopack rejected links outside its root. A preserved .next cache
was moved outside the source tree after Tailwind scanned its binary contents.
The start-turn harness expected 202 although the route returns 201; the existing
successful task was recovered and followed instead of submitting a duplicate.
Native iconutil required execution outside the outer sandbox; the unchanged full
asset generation command then succeeded. None of these adjustments substituted
a model, device, backend, or browser result.
