/**
 * The server-only index.
 *
 * Everything here reaches a capability's *implementation* — the lazy entry
 * modules in `capability-modules.ts` and the read-side handler collection built
 * on top of them. Those modules pull in node-only dependencies (a sandbox
 * provider drags in the OpenTelemetry node SDK, which requires `async_hooks`),
 * so nothing in this subpath may appear in a browser graph.
 *
 * Kept out of the package's main entry for the same reason `./ui` is, in the
 * opposite direction. The main entry is the isomorphic surface: names,
 * presentation metadata and the tool table, imported by both the app's client
 * components and the backend. A lazy `import()` does not save it — a bundler
 * still has to produce the chunk, so it still resolves the node-only graph and
 * still fails the client build. The boundary has to be at the module the client
 * imports, which is why this file exists rather than a `"server-only"` marker
 * inside `capability-modules.ts`.
 */
export * from "./artifact-view-handlers";
export * from "./capability-modules";
