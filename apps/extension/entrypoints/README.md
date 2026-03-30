# entrypoints

Purpose of this directory:

- Keep extension runtime entry files separated by lifecycle context.
- Make background/content/popup responsibilities explicit.

WXT entrypoint layout:

- `background.ts`
- `content.ts`
- `popup/index.html`
- `popup/main.ts`

Current skeleton defaults:

- content script `matches` is set to `<all_urls>` as a placeholder.
- shared SDK bootstrap is located at `../lib/sdk.ts`.
