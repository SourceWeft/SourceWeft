# Local PC execution — real E2E evidence

Date: 2026-09-09. Branch: `codex/pc-local-macos`.

## Result and scope

**The real Web → Agent → production Rust local host → macOS Seatbelt command →
physical file → conversation execution path passed.** The native first-time
login/settings/folder-picker UI is still unverified because computer-use reports
that the Mac is locked. Locking did not prevent the native host's real Keychain
enrollment, WebSocket connection, or command execution in this test.

The browser was an independent Playwright browser, logged in through the ordinary
Web email/password form. It selected the real connected Mac before creating a new
conversation, submitted a command, and clicked the ordinary single-action
`Approve` button. It did not inject a browser session or mock tool/model results.

`remote_host_live.rs` compiled the production `remote_host.rs` and used actual
Keychain, WebSocket, SQLite and Seatbelt code. A fixture called the real isolated
authentication and enrollment endpoints to supply the ticket instead of operating
the native enrollment UI. This is an execution E2E, not a packaged desktop
onboarding E2E; the distinction is recorded in `uiEnrollmentCovered: false`.

## Evidence

- Thread: `74283041-2165-43e2-b114-8cef05507e3b`.
- Device: `bf31e356-6859-4849-bef0-ee30d8f96409`.
- Native workspace: `8f8492cc-b3c3-4849-8619-f97bdfcd8134`.
- Invocation: `bf31e356-6859-4849-bef0-ee30d8f96409:69e103a9-99f8-4f7a-9aed-2324a26a8c3e`.
- Command: `printf 'WEB_LOCAL_E2E_5dcf5e35\n' > browser-triggered.txt; /bin/pwd; /bin/cat browser-triggered.txt`.
- Exit code: `0`. File content: `WEB_LOCAL_E2E_5dcf5e35` followed by one newline.
- All sandbox records for this thread have provider `local` and reference the
  same native workspace. No cloud sandbox was used for this thread.
- PostgreSQL invocation output equals the completed native SQLite journal result,
  and matches the actual file and assistant message.
- Browser assertion verified the successful output and absence of an execution
  location selector in the existing conversation.

Evidence directory (relative to this worktree):
`output/playwright/local-pc/live-5dcf5e35-1684-43b2-9819-691e2ee16ed7/`.

- `execution-verification.json`: correlated database/native/file checks.
- `browser-success.png`: actual browser result screenshot.
- `native-data/local-host/state.sqlite3`: actual invocation journal.
- `native-data/task-workspaces/8f8492cc-b3c3-4849-8619-f97bdfcd8134/files/browser-triggered.txt`: physical result.
- `host-ready.json`: actual host connection evidence.
- Enrollment ticket and environment fixtures are private and must not be committed.

## Defects observed; not a complete product sign-off

1. Four skill-initialization commands attempted to create cloud path `/skills`.
   Seatbelt denied them (`mkdir: /skills: Operation not permitted`). The requested
   command itself subsequently succeeded. Skill installation needs provider-aware
   paths; these incidental failures remain in the evidence, not hidden as passes.
2. The command approval card displayed `CWD: /workspace` although execution used
   the actual native workspace. Approval presentation needs the resolved local
   path so it accurately describes what is approved.
3. Packaged native first-time authentication/settings and selected-folder UI remain
   untested. Persistent reconnect/re-enable, durable long tasks, default local
   setup without manual enrollment, managed overwrite/backups, browser automation
   and desktop computer use remain incomplete or unverified.

A separate real native UI attempt found and fixed bridge initialization: the
SourceWeft bridge is now injected on the main WebView initialization rather than
through the invoke-script hook. After rebuilding, `Sign in with browser` opened
successfully. Subsequent native UI inspection reported a locked Mac.

## Isolated environment

- Web: `http://localhost:3100`; API/device gateway: `http://localhost:3101`.
- Agent queue: `sourceweft-local-pc-e2e`, independent worker.
- Separately created and migrated E2E PostgreSQL database; original developer DB
  and original port 3000/3001 services were not used.
- Existing configured model gateway and default model, no substitute provider.
- Same Web UI used in browser and Tauri; no separate native pages were added.

## Other completed verification

- 11 real HTTP/PostgreSQL immutability checks: cloud↔local, PC and assigned
  workspace replacements rejected, including direct SQL and concurrent attempts.
  Local conversation creation and initial binding are atomic.
- Actual browser: existing cloud/local conversations have no execution selector;
  only a new conversation can choose its target.
- Browser-created offline local thread
  `346e065c-815d-480e-812e-4681e05b6ba2` retained its target through submissions.
  Corrected failure is `DEVICE_OFFLINE`, with zero sandbox, local invocation,
  workfile or artifact records; no cloud fallback.
- Three physical Seatbelt integration tests passed: real command and idempotent
  replay; cancellation after start without post-cancel output; loopback proxy
  target rejected with HTTP 403. A separate block-all isolation probe passed.
- 26 focused backend tests and 123 contracts tests passed. Rust check, backend
  typecheck and Web typecheck passed at their previously recorded checkpoints.
- An accidental broader backend test invocation was stopped and is not reported
  as passing. Focused Vitest runs used explicit filenames directly with Vitest.

## Reproduction entry points

1. Start isolated API, Web and worker using the existing private fixture.
2. Compile `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --test remote_host_live --no-run`.
3. Run `pnpm exec tsx src/scripts/local-pc-live-enrollment.ts` from `apps/backend`.
4. Before the 60-second enrollment ticket expires, run the ignored live host test
   with `SOURCEWEFT_API_BASE_URL=http://localhost:3101` and
   `SOURCEWEFT_E2E_RUN_DIR` set to the generated absolute run directory.
5. Use a real browser to log in, select the connected Mac on a new conversation,
   submit the marker command and approve it once.
6. Run `local-pc-live-verification.ts <threadId>` for this recorded marker. A new
   run should supply/update its marker explicitly rather than claim this fixed
   assertion is a general-purpose suite.
7. Write the run directory's `stop` file to shut down the bounded native test host.

Native UI onboarding must be tested separately when desktop interaction is
available. Manual unlock is not a prerequisite for the execution test above.
