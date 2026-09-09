# PC conversation files

Approved in conversation on 2026-09-10. PC conversations use their bound physical
working directory as the sole store for working files. Sources remain indexed,
read-only reference material. Cloud Workfiles keep their current persistence.

## Behavior

- The desktop creates a durable per-account/per-thread directory by default.
  Before creating a conversation, a user on the selected desktop can choose an
  existing directory with a native picker. The picker issues an account-scoped
  opaque grant; the model/browser cannot authorize arbitrary paths.
- A conversation's device and directory grant are immutable. Existing directories
  may be shared by multiple conversations. Removing a conversation never deletes
  the directory. Missing/replaced directories and offline devices fail explicitly.
- PC file tools and execute use the same physical root. PC turns expose neither
  the DB /workfiles mount nor prepare/collect bridge tools. Files persist locally;
  publishing an artifact is explicit and is not synchronization.
- A separate Files entry presents the live local tree and text preview, with the
  physical root and device status. Sources hides Workfiles for PC conversations.
  Disk reads refresh after commands and periodically while the panel is open.
- The backend authorizes every directory request against the private thread and
  its device binding. No DB file-content cache or offline fallback is introduced.
  Existing DB Workfiles are preserved but never silently copied or selected.
- Text editing supports existing files, rejects links/special files, and detects
  changes made between read and write. Binary reads support explicit downloads
  and artifact publication; text preview continues to require UTF-8.

## Implementation and verification

1. Remove PC DB mounts/bridge tools and update provider-aware prompts.
2. Add authenticated directory APIs and a separate live Files panel.
3. Implement native selected-directory grants, immutable binding, and safe edits.
4. Test local/cloud tool routing, stale/offline UI handling, account/path boundaries,
   external changes, binary transfer, shared directories and restart reuse.
5. Run focused Vitest suites, backend/Web type checks, Rust tests and check.
   Real macOS sandbox tests remain required; do not substitute unconfined runs.

No automatic migration or deletion of existing user files. Directory access is
scoped to the explicitly selected root; system runtime reads retain the existing
Seatbelt policy. The native picker is supported only on the selected Mac; a remote
browser can use automatic allocation but cannot silently choose a local path.

Implementation and verification notes are maintained in
`apps/desktop/LOCAL_FILES.md`. Native picker/file-panel visual acceptance is blocked
by the locked Mac; code and real native filesystem/command tests are complete.
