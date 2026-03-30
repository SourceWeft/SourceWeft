# Extension

This directory hosts the browser extension application.

Framework: WXT.

Compatibility target (V1):

- Chrome (default)
- Edge
- Manifest Version 3

- `entrypoints/background.ts`: background lifecycle and queue coordination
- `entrypoints/content.ts`: content script integration point (`<all_urls>` in this skeleton)
- `entrypoints/popup/index.html` + `entrypoints/popup/main.ts`: popup UI entry
- `lib/sdk.ts`: shared SDK bootstrap placeholder for extension clients

Auth MVP:

- Uses OAuth2 Authorization Code + PKCE via `chrome.identity.launchWebAuthFlow`.
- Stores OAuth tokens in extension local storage.
- Popup supports sign-in, refresh, user-info check, and sign-out.

The extension should use shared contracts and SDK from `packages/`.

Environment template: `apps/extension/.env.example`.
