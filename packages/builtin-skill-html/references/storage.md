# Saving data and links

Use this only when the user wants the page to remember things (a to-do list, a tracker, saved settings, form answers) or to link out to the web.

## Declaring storage

Declare it in the page's artifact metadata. Without the declaration, every storage call rejects with `unavailable`.

```html
<meta
  name="sourceweft:artifact"
  content='{"schemaVersion":1,"capabilities":["storage"]}'
/>
```

- `storage`: each viewer gets their own private data for this artifact. Use this by default.
- `storage.shared`: adds data shared by everyone who can open the artifact, such as a team tracker or a sign-up sheet. Declare it only when the user asks for shared data. It does nothing until a workspace editor or admin approves this exact version. Every new version needs a new approval, and each viewer confirms before first use. Tell the user that approval is required.

Data belongs to the artifact, not to the version, so republishing keeps it. Keep a `schemaVersion` field in the records and migrate old shapes when reading them.

## API

The host provides `window.sourceweft.storage`. It exists only when SourceWeft renders the page. In local QA, downloads and file previews it is missing, so guard every use and fall back to in-memory state:

```js
const storage = window.sourceweft?.storage;
async function load() {
  if (!storage) return null;
  try {
    return await storage.get("settings");
  } catch (error) {
    return null;
  }
}
```

Key/value (the `kv` collection):

- `storage.get(key, { scope })` resolves to the value or `null`.
- `storage.set(key, value, { scope, ifMatch })` resolves to `{ etag }`.
- `storage.delete(key, { scope, ifMatch })`.
- `storage.list(prefix, { scope, limit, cursor })` resolves to `{ keys: [{ key, etag, updatedAt }], cursor }`.

Collections hold JSON records with filtering, sorting and pagination:

```js
const tasks = storage.collection("tasks"); // { scope: "shared" } for shared data
await tasks.set("t1", { title: "Ship", done: false, due: "2026-11-01" });
const { records, cursor } = await tasks.query({
  where: [{ path: "done", op: "eq", value: false }],
  orderBy: [{ path: "due", dir: "asc" }],
  limit: 20,
});
// records: [{ id, data, etag, createdAt, updatedAt }]; pass cursor back for the next page.
```

Filter operators are `eq`, `ne`, `in` (up to 20 values), `contains` (array or object containment), `exists`, and `lt`, `lte`, `gt`, `gte`. Range operators compare a number with a number and a string with a string. Paths are dotted field names such as `meta.owner`. A query takes up to 8 filters and 2 sort fields. Missing fields sort as null. Numbers sort before strings.

## Limits and errors

- Values are JSON. Object key order is not preserved; use arrays when order matters.
- Each record is limited to 256 KB.
- A collection holds at most 10,000 records, and 50 collections are allowed.
- Per artifact: 5 MB per viewer, and 20 MB of shared data.
- Pass `ifMatch` with the last `etag` to avoid overwriting someone else's change.

Errors reject with an `Error` whose `code` is one of the following. Show a clear message for each; never fail silently.

- `unavailable`
- `forbidden`
- `consent_required`
- `conflict`
- `quota_exceeded`
- `rate_limited`
- `query_too_expensive`
- `invalid_request`

Never store passwords, tokens, keys or other secrets. Shared data is visible to everyone with access, and a page can show what it reads.

## Links

Use ordinary `<a href="https://…">` links. SourceWeft asks the viewer to confirm before opening them in a new tab. Only `http` and `https` links, and in-page `#anchors`, are allowed. Never navigate with `location = …` or `window.open` from script: the page cannot leave its frame, and SourceWeft disconnects storage when a page tries.
