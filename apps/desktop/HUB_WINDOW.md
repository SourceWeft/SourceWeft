# Detached Hub window

Hub implementation: `codex/desktop-hub-window`. The local main integration also
preserves the existing PC conversation-directory feature.

The desktop Hub header can open one native auxiliary window. The main sidebar
stays visible until the auxiliary view has authenticated, received the current
snapshot and acknowledged it. Repeated opening focuses the existing window.
Docking restores the inline view; closing the auxiliary window leaves Hub hidden
until its main-window entry is selected again. Neither action exits the app.

The auxiliary route reuses Hub components and authentication without mounting
another chat engine, dashboard sidebar or local-device connection controller.
Native IPC is restricted by window label, configured origin, route and message
direction. The Hub capability does not grant local-host enrollment or autostart
management. Packaged `tauri://` origins have an explicit validation test.

## Context and operation ownership

- Chat selection commands carry an application session, account-scoped context
  key and revision. Navigation invalidates the old writable registration before
  the destination page finishes loading. Repeated command IDs are deduplicated.
- Workspace resources retain their existing scopes, including workspace-wide
  Artifacts. On local main, PC Files remains a separate surface; only confirmed
  cloud conversations may load Workfiles. Restored cloud tabs wait for execution
  metadata instead of being prematurely reset.
- Tabs, search, scroll and preview identifiers travel between views. Source-tree
  expansion preferences use an account/workspace/conversation scope. Skills are
  remembered per conversation for the app session. Creating a conversation
  promotes the new-chat Hub view and Skills selection to the real thread ID.
- Open forms and client uploads retain their original context while following
  is paused. Save/cancel uses the existing form controls. Discard-and-follow is
  explicit. Cross-workspace transitions hide the old form and its portals; the
  user can return to the original workspace or discard the form.
- The first implementation requires a client upload/resource operation to
  finish before closing or docking its window. It does not add transport
  cancellation to the existing upload SDK. Server-side processing continues
  independently. Automatic source selections from an old conversation are
  queued for that conversation and applied after its sources load again.
- The composer checks the auxiliary view before sending. If selections are
  unconfirmed or changed while waiting, it asks the user to review and send again.
- Leaving chat retains the last loaded content with editing disabled. Logout
  clears the account's auxiliary state and closes the native window. A dropped
  connection disables mutations until a full snapshot is received again.

## Verification and outstanding native acceptance

The implementation was checked with the repository's pinned pnpm 10.19.0 and
frozen lockfile. The Web dependency packages were built before type checking.

- Hub protocol, host coordination, auxiliary React view and existing Hub suites:
  102 tests passed across 15 files, including cloud-tab restoration and rejection
  of cloud Workfiles for detached local conversations.
- Web `next typegen && tsc --noEmit`: passed.
- Desktop binary Rust tests: 3 passed, including relay origin/direction checks.
- Changed Web files: ESLint passed with zero warnings.
- Desktop PNGs: RGBA format verified with unchanged decoded visual pixels. The
  generator retains opaque white artwork and leaves iOS alpha behavior unchanged.

The React coordination tests mock the native transport. They are not native
window acceptance tests. The native login screen and browser handoff were
exercised in an isolated environment, but the Mac locked again before completing
login and could not be automatically unlocked. Consequently **real native focus, system
close, geometry restoration and shared login have not yet been verified**.
There is no browser fallback for an unsuccessful native-window handshake.

After unlocking, validate with the Web server running from this worktree and a
desktop build pointing at that server:

1. Sign in through the normal desktop flow, open Hub, and verify there is exactly
   one native Hub window and the main sidebar only disappears after it loads.
2. Switch A → B → A; check title/content/selection consistency and browsing state.
3. Change a Hub selection and immediately send in the main window; verify the
   send either uses the confirmed selection or explicitly waits for review.
4. Open a form or start an upload, then change conversations/workspaces. Verify
   operation ownership and the temporary following pause.
5. Preview content, dock, close, reopen, minimize the main window and refresh it.
   Confirm expected focus, content and connection behavior.
6. Verify account logout, a failed initial handshake, and geometry after removing
   an external display. Repeat authentication/URL checks in a packaged build.
