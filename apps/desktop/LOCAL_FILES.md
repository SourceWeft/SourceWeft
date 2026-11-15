# PC conversation files

PC conversations use one physical working directory. Agent file tools, command
execution, the Files panel, and the Hub Workfiles tab access the same files.
Sources remains the indexed reference library. The Hub retains Workfiles for both
cloud and PC conversations; the label does not imply a second storage copy. Database Workfiles and prepare/collect tools are available only
in cloud conversations; existing PC Workfile records are preserved without an
implicit migration, synchronization, or fallback.

## Choosing and using a directory

A new PC conversation automatically gets a durable task folder in a visible
location on that computer: `<task folder location>/<date>/<name>`, for example
`~/SourceWeft/2026-11-15/0a1b2c3d`. The date is the computer's local date and the
name is the start of the workspace ID; neither comes from the conversation or the
model. In the selected computer's desktop client, choose an existing directory
before creating the conversation instead. The native picker issues an opaque,
account-scoped directory grant. Neither browser requests nor model tool arguments
can grant access by supplying a path.

### Task folder location

The location is `SourceWeft` in the user's home directory (`%USERPROFILE%\SourceWeft`
on Windows) unless another one is chosen in Settings → This computer → Default task
folder. It is outside Documents, so it does not trigger the macOS Documents
permission prompt and is not picked up by Desktop & Documents cloud sync. The
setting is stored on the computer, applies to conversations created afterwards,
and never moves an existing folder. A chosen location must be an existing directory
outside application storage; a missing one (an unplugged drive) is reported as
`TASK_FOLDER_MISSING` and is not recreated. The default location is created by the
first task that uses it.

The backend asks the computer where the folder goes (`workspace.reserve`). The
computer records the answer and creates nothing; the folder is created by the first
real operation, so a conversation that never uses a tool leaves no empty folder.
The ownership marker of each automatic folder stays in application storage
(`task-workspaces/<id>/owner.json`); the visible folder holds task files only.

Compatibility, in both directions:

- A computer whose desktop client does not announce `workspace.reserve` keeps the
  earlier layout, `<app data>/task-workspaces/<id>/files`, at a path the backend
  derives from the workspace ID.
- A backend that does not send `workspace.reserve` gets that same earlier layout
  from an updated desktop client.
- Conversations created before this change keep their folder in application storage.
  Nothing is migrated.

Before sending the first message, the composer's folder control shows “Task folder”
for the automatic choice, the folders already granted on that computer with their
parent path, and “Choose a different folder…”. Opening an empty draft
never allocates storage. Selecting an authorized directory immediately shows its
path, subdirectories and file previews, without creating a conversation. Cloud
drafts instead show “Conversation cloud files”. The composer and all Hub surfaces
share the same selection, including the detached Hub window.

Draft reads use `/v1/local-devices/:deviceId/folders/:folderId/files` and the
read-only `folder.list` / `folder.read` device actions. The backend checks device
access and the owner-scoped live directory grant both before dispatch and before
returning results. The native host verifies the grant and directory identity,
rejects path escape, symlinks and hard-linked files, and allocates no workspace.
Preview/download is limited to 1 MiB and listing to 500 entries. File bytes use
the short-lived transfer channel; they are not saved in the invocation journal.
Offline computers, revoked grants and missing/replaced directories retain the
selection and show an explicit error. They never trigger automatic replacement.

The conversation's PC and directory selection cannot change after creation. A
selected directory can be reused by multiple conversations. Deleting a conversation
never deletes the physical directory. Missing/replaced directories, invalid grants,
and offline devices return errors; they do not create replacement storage.

After creation, the conversation header keeps the chosen directory name visible
beside the computer name; the full path is available on hover and in Conversation
details, which also copy the path and, in the desktop client on that computer, show
the directory in the file manager. The desktop client only opens directories it
works in (the task folder location, a conversation's working directory, a granted
directory). The selection is read-only after creation.

Hub Workfiles shows “Cloud · saved with this conversation” for database-backed
cloud files. For PC conversations it shows “This computer” and the device name,
then lists the bound physical directory. The local view supports directory
navigation, text preview, download and filtering. It refreshes every three seconds
while open. When the PC is unavailable it marks the last listing as stale and
closes its file preview. External edits appear on the
next read. The separate Files view uses the same endpoint and disk files.

## Offline conversations

The Web chat, composer, and file panels share an account/session-scoped availability
check every three seconds while visible. The backend verifies access and requests
`workspace.check` from the PC; this probe reads the directory binding and identity
without allocating or repairing directories. A never-used automatic directory is
still allocated lazily by the first real operation. Native hosts must include the
`workspace.check` implementation before this backend/Web update is deployed.

An unavailable PC leaves history readable and drafts editable. Sending, rerunning,
approving tools, and file access are blocked; Stop, Reject, and reconnect remain
available. Disabled remote access, missing browser authorization, directory errors,
and an offline PC retain distinct reasons. A detached Hub obtains status through
the main window's proof; losing that window does not declare the PC offline.

Existing file listings are marked stale while inaccessible. Reconnection validates
the directory again and refreshes it. Failed commands are never replayed automatically;
queued chat messages require an explicit resume after an availability interruption.
Backend startup/resume and approval checks enforce the same boundary. Durable runs
also monitor PC availability and abort ongoing agent work if it is lost.

Connection replacement and close settle pending operations as cancelled, and
dispatched operations without a result as outcome unknown. Dispatch claims are
persisted before delivery and cannot be replayed by a replacement connection.
Unknown results require checking the PC before retrying; a cancellation request
alone is not proof that a physical command stopped. Detection time includes the
existing connection lease, not just the three-second Web polling interval.

Click a file to open the shared in-app preview dialog; clicking a directory only
navigates into it. Text and code use line numbers and copying, and Markdown offers
rendered Preview and Source tabs. The original list stays mounted while preview
loads and while it is open; closing returns keyboard focus to the selected file.
Preview reads refresh independently and discard late results after closing or
switching conversations. Unsupported binary content shows a download action.

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

## Rollout of visible task folders

No backend database migration. The desktop client upgrades its local SQLite schema
to version 5 on first start (a `root_path` column and a settings table); an older
desktop client refuses a version 5 database and asks for an update. Backend and
desktop client can be deployed in either order (see Compatibility above); the
visible location takes effect for new conversations once both are updated.

## Rollout

Apply database migrations through `0039_draft_folder_reads.sql` using the usual
backend migration command, then rebuild/restart the desktop client and backend/Web services.
The desktop automatically upgrades its local SQLite schema. Draft directory previews require the updated native host; old hosts report an unsupported action until upgraded. Selected
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
