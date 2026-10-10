# PC conversation files

PC conversations use one physical working directory. Agent file tools, command
execution, the Files panel, and the Hub Workfiles tab access the same files.
Sources remains the indexed reference library. The Hub retains Workfiles for both
cloud and PC conversations; the label does not imply a second storage copy. Database Workfiles and prepare/collect tools are available only
in cloud conversations; existing PC Workfile records are preserved without an
implicit migration, synchronization, or fallback.

## Choosing and using a directory

A new PC conversation automatically allocates a durable directory under the app's
`task-workspaces/<id>/files` storage. In the selected computer's desktop client, choose
an existing directory before creating the conversation instead. The native picker
issues an opaque, account-scoped directory grant. Neither browser requests nor
model tool arguments can grant access by supplying a path.

Before sending the first message, Files shows “Conversation folder” for the
automatic choice and offers “Choose existing folder”. Opening an empty draft
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
details. The selection is read-only after creation.

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
are rejected. Descriptor-relative macOS operations and handle-pinned Windows operations reject symlinks, hardlinks,
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
- The native folder picker requires the selected computer's connected desktop client.
  A browser on another device can use automatic allocation and inspect files when
  the selected PC is online, has enabled access from other devices, and the
  browser session has connected to it.
- Existing skill/runtime asset installation retains its own provider constraints;
  this change does not validate arbitrary cloud-only dependencies on macOS.

## Windows with niubash

Windows installers include [niubash](https://github.com/unixwin/niubash) 1.3.3
and its portable command utilities, used through `niu.exe -c`. No separate Shell
installation, PATH changes or environment configuration are needed. The native
host uses `resources/niubash/niu.exe` beside the installed desktop executable.
Missing bundled files fail explicitly and require repair/reinstallation;
PowerShell, CMD, Git Bash and cloud execution are never selected as a substitute.
An optional `SOURCEWEFT_NIUBASH_PATH` absolute path overrides the bundled runtime;
an invalid override fails rather than selecting another Shell.

Windows support is **trusted local execution**, not the macOS Seatbelt sandbox.
It is available by default after installation. Users still connect/enable their
computer through the existing desktop authorization flow. Administrators can
disable command execution with `SOURCEWEFT_WINDOWS_TRUSTED_LOCAL_EXECUTION=false`
in the desktop process environment; only `true` and `false` are valid overrides.
Existing account/session authorization, private conversation ownership,
directory grants and tool approvals still apply. Approved commands run as the
current Windows user and can access that user's files, installed tools and
network beyond the selected task directory. Do not enable it for untrusted work.
A Windows isolation sandbox is not implemented by this mode.

Commands use Bash syntax with forward-slash native drive paths (`C:/task`), not
PowerShell syntax. The command environment keeps the native tool PATH and Windows
loader/app-data variables, sets HOME and temporary directories to the task root,
and excludes other inherited variables, including `NIU_ENV` and `BASH_ENV`.
niubash and its MIT license stay in SourceWeft's private resources; no machine-wide
Shell change is performed. The pinned official archive is SHA-256 checked at
build time. Windows `tauri build` and `tauri dev` prepare these resources
automatically. Build hosts need access to GitHub for the first download; cached
archives are verified on every build. For an offline build, pre-seed the cache
explicitly with `node scripts/ci/prepare-niubash.mjs --archive <official-zip>`.
No runtime download is performed on users' computers.
The Windows installer uses the current user's install directory. On first use,
the official portable runtime creates its command hardlinks there automatically;
this does not change the system PATH or require a separate installation step.
Installer replacement/uninstall also removes these generated links from the
private runtime directory, preventing stale aliases after a runtime upgrade.

Windows device credentials are account-scoped in Windows Credential Manager;
macOS continues using Keychain. Directory identity uses the Windows volume and
file ID. Native file tools hold ancestor handles and reject reparse points
(including junctions), hardlinks, traversal, alternate streams and device names.
They retain the same physical directory as execute. Existing-file writes check
the observed content under a write-exclusive handle and durably back up old bytes;
they write through that handle rather than macOS's atomic rename commit. A crash
during a Windows write may require recovery from the backup.

Each command starts suspended, joins a Job Object, then resumes. Cancellation,
timeout, desktop shutdown and normal completion terminate remaining descendants.
Failure to establish process control stops execution. Native output remains
bounded and a repeated successful invocation returns its journaled result without
executing again. Local drive directories are supported; UNC/network-share paths
are not part of this initial path protocol.

Verification on Windows requires prepared bundle resources and native Node on PATH:

```sh
node scripts/ci/prepare-niubash.mjs
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --test windows_local_execution
```

These tests use temporary directories and the bundled runtime without path or
trusted-mode opt-in settings. They cover real niubash execution,
file tools, Unicode/space/empty arguments, exit codes, output limits, removed
startup hooks, timeout, child-process cancellation, replay protection, directory
replacement, hardlinks, file versions and account boundaries.

### Windows verification (2026-10-10)

Passed locally on Windows: all 41 desktop Rust tests using the pinned portable
niubash 1.3.3 archive, 13 backend device/path/route tests, 58 sandbox path/file
backend tests, and 9 Web native-session tests. Backend, sandbox and Web TypeScript
checks passed after building the existing UI package and generating Next route
types. The CI installer download, SHA-256, extraction and niubash smoke
check also passed locally. Backend test database operations were mocked.

Native picker clicks, a signed desktop installer, live backend chat execution and
the GitHub-hosted CI run have not been verified. macOS and Linux runtime checks
were not run on this Windows host. This earlier verification used process-local
opt-in before the bundled runtime became the default.

### Bundled Windows runtime verification (2026-10-10)

Passed locally: 41 desktop Rust tests, 12 archive-integrity/download-publication
script tests, and all 3 Windows integration tests in a relocated Release layout
whose path contains Chinese characters and spaces. Execution used the bundled
runtime with no niubash path or trusted-mode environment settings; a command
pipeline also passed with an empty PATH. First-launch command activation was
checked from a fresh copy of the official portable files.

The unsigned Windows x64 NSIS installer was rebuilt with all 13 portable runtime
and license/notice files. Its generated install script includes private-runtime
cleanup for replacement/uninstall. The installer has not been installed here;
native login/picker/chat acceptance and actual uninstall remain unverified.

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
