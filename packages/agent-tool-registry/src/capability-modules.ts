/**
 * Static entry-module map for builtin capability packages.
 *
 * This registry already statically imports every builtin package for its tool
 * definitions; this map exposes the same packages as *loadable entry modules*
 * so hosts can reach their factories (`createCapabilityAgentTools`,
 * `createDeliverablePipelines`) without a variable dynamic import.
 *
 * Why the map has to exist: a variable `import(packageName)` is not statically
 * analyzable, so a bundler leaves it in the output as a runtime import. At
 * runtime it resolves through node_modules to the package's TS entry
 * (`exports: "./src/index.ts"`), which a plain `node dist/…` process cannot
 * load. Dev and test both run through TS loaders, so that failure is invisible
 * outside a real bundled deployment. It cannot be replaced by runtime
 * registration — the constraint is build-time: whatever discovers a module, the
 * *reference* to it must still be statically analyzable to be bundled.
 *
 * It could be removed by giving these packages a real `dist` build and pointing
 * `exports` at it; then plain `import(packageName)` would work everywhere and
 * this file would go away.
 *
 * Adding a builtin capability that ships code means adding one line here and
 * one dependency in this package's package.json. `tests/capability-modules.
 * test.ts` fails the build if a package exporting either factory is missing.
 */

/** A loaded capability entry module; consumers narrow to the factory they need. */
export type CapabilityEntryModule = Record<string, unknown>;

export type CapabilityEntryModuleLoader = () => Promise<CapabilityEntryModule>;

export const BUILTIN_CAPABILITY_MODULES: Record<
  string,
  CapabilityEntryModuleLoader
> = {
  "@sourceweft/builtin-connector-notion": () =>
    import("@sourceweft/builtin-connector-notion"),
  "@sourceweft/builtin-retrieval": () =>
    import("@sourceweft/builtin-retrieval"),
  "@sourceweft/builtin-tool-generate-image": () =>
    import("@sourceweft/builtin-tool-generate-image"),
  "@sourceweft/builtin-tool-publish-artifact": () =>
    import("@sourceweft/builtin-tool-publish-artifact"),
  "@sourceweft/builtin-tool-video-presentation": () =>
    import("@sourceweft/builtin-tool-video-presentation"),
  "@sourceweft/builtin-tool-web-search": () =>
    import("@sourceweft/builtin-tool-web-search"),
};

export function loadBuiltinCapabilityModule(packageName: string | null | undefined) {
  return packageName ? BUILTIN_CAPABILITY_MODULES[packageName] : undefined;
}
