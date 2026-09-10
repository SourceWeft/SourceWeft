# PC conversation files

PC conversations use one physical working directory. Agent file tools, command
execution, the Files panel, and the Hub Workfiles tab access the same files.
Sources remains the indexed reference library. The Hub retains Workfiles for both
cloud and PC conversations; the label does not imply a second storage copy. Database Workfiles and prepare/collect tools are available only
in cloud conversations; existing PC Workfile records are preserved without an
implicit migration, synchronization, or fallback.

## Choosing and using a directory

A new PC conversation automatically allocates a durable directory under the app's
`task-workspaces/<id>/files` storage. In the selected Mac's desktop client, choose
an existing directory before creating the conversation instead. The native picker
issues an opaque, account-scoped directory grant. Neither browser requests nor
model tool arguments can grant access by supplying a path.

The conversation's PC and directory selection cannot change after creation. A
selected directory can be reused by multiple conversations. Deleting a conversation
never deletes the physical directory. Missing/replaced directories, invalid grants,
and offline devices return errors; they do not create replacement storage.

After creation, the conversation header keeps the chosen directory name visible
beside the computer name; the full path is available on hover and in Conversation
details. The selection is read-only after creation.

Hub Workfiles shows “Cloud · saved with this conversation” for database-backed
cloud files. For PC conversations it shows “This computer” and the device name,
then lists the bound physical directory. The local view supports directory
navigation, text preview, download and filtering. It refreshes every three seconds
while open and clears unavailable content on errors. External edits appear on the
next read. The separate Files view uses the same endpoint and disk files.

Agent reads, writes, edits, glob and grep use physical paths under this directory.
Edits compare the previous content before writing, so intervening external edits
are rejected. Descriptor-relative reads and writes reject symlinks, hardlinks,
special files and path traversal. Read-only delegates and the interpreter receive
read access to this directory and `/kb`, without a `/workfiles` mount.

File contents still travel through the backend when requested by the Agent or file
panel, and tool invocation journals retain execution records. This is not a claim
that model processing or file inspection happens entirely offline. There is no
second editable Workfiles copy. Artifact publication remains explicit.

## Current limits

- Native file reads/writes/downloads: 1 MiB per file, including binary downloads.
- Directory listing/recursive enumeration: at most 500 entries; exceeding this
  fails explicitly and asks for a narrower directory.
- Text search: at most 200 candidate text files and 1 MiB total; up to 50 matches.
- The native folder picker requires the selected Mac's connected desktop client.
  A browser on another device can use automatic allocation and inspect files when
  the selected PC is online, has enabled access from other devices, and the
  browser session has connected to it.
- Existing skill/runtime asset installation retains its own provider constraints;
  this change does not validate arbitrary cloud-only dependencies on macOS.

## Rollout

Apply database migrations through `0034_local_work_contexts.sql` using the usual
backend migration command, then rebuild/restart the desktop client and backend/Web services.
The desktop automatically upgrades its local SQLite schema to version 3. Selected
directory requests require both this migration and the updated native host. There
is no automatic migration of old DB Workfiles into user directories.

## Verification (2026-09-10)

Passed: backend and Web TypeScript checks; focused backend route/provider/assembly
and filesystem tests; Web command-confirmation tests; sandbox file backend tests;
VFS mount tests; interpreter tests; native workspace tests; PostgreSQL migration
and trigger tests in a transaction-scoped isolated schema; real macOS Seatbelt
execution, cancellation, egress and filesystem boundary tests. The selected-folder
integration test writes input through the native file API, executes in that
folder, lists/edits the output, and reads a subsequent external edit.

Test environment adjustments were explicit: local installed executables were
used because the pnpm launcher attempted an unwanted dependency reinstall; core
billing flags were supplied only to test processes to match the core source tree.
Rust tests temporarily referenced the repository's original icon because concurrent
icon changes were RGB and Tauri requires RGBA. Those icon files were not modified
by this change. Current-icon packaging is not covered by that test run.

Native picker clicks and rendered file-panel acceptance remain unverified: the
computer-use tool reported that the Mac is locked. The schema migrations were subsequently applied to the configured local
`127.0.0.1:5432/sourceweft` database on 2026-09-10. Its history contained older
subagent/persona migrations whose timestamps caused Drizzle to skip the missing
PC foundation migration. After a successful transaction dry run with rollback,
`0029_loving_rhino` was applied and recorded with its original hash/timestamp;
Drizzle then applied `0030` through `0033`. Existing history was preserved.
Post-migration verification confirmed all five records, four local tables, the
directory-grant constraint, three binding triggers, and no pending migrations.
