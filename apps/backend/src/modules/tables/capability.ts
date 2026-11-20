import { loadBuiltinCapabilityModule } from "@sourceweft/agent-tool-registry/server";
import {
  readTableCapability,
  TABLE_CAPABILITY_FACTORY,
  TableCapabilityUnavailableError,
  type TableCapabilityModule,
  type TableGenerationMembers,
} from "@sourceweft/contracts/table-capability";

/**
 * The one place the backend reaches the table capability.
 *
 * Like the study capability, the package is loaded through the static module
 * table in `@sourceweft/agent-tool-registry/server` and narrowed to its
 * contract (`@sourceweft/contracts/table-capability`); the backend never
 * imports the package. The table capability ships with the backend, so a
 * missing module or member is a deployment fault: it throws
 * `TableCapabilityUnavailableError` instead of degrading quietly.
 */
export const TABLE_CAPABILITY_PACKAGE = "@sourceweft/builtin-tool-table";

type ModuleLoader = typeof loadBuiltinCapabilityModule;

let cached: Promise<TableCapabilityModule> | null = null;

async function loadModule(loader: ModuleLoader) {
  const load = loader(TABLE_CAPABILITY_PACKAGE);
  if (!load) {
    throw new TableCapabilityUnavailableError(
      `${TABLE_CAPABILITY_PACKAGE} is not in the builtin capability module table`,
    );
  }
  return readTableCapability(await load());
}

/** Loads the module once per process and returns one required group. */
async function loadTableGroup<G extends keyof TableCapabilityModule>(
  group: G,
  loader: ModuleLoader,
): Promise<NonNullable<TableCapabilityModule[G]>> {
  const usesDefault = loader === loadBuiltinCapabilityModule;
  const pending = usesDefault ? (cached ??= loadModule(loader)) : loadModule(loader);
  try {
    const capability = await pending;
    // Checked again with the requirement, so a missing group or member is
    // named in the error.
    return readTableCapability(
      { [TABLE_CAPABILITY_FACTORY]: () => capability },
      group,
    )[group]!;
  } catch (error) {
    // A failed load is never cached: the next call tries again.
    if (usesDefault) cached = null;
    throw error;
  }
}

/** The generation engine members. */
export function loadTableGeneration(
  loader: ModuleLoader = loadBuiltinCapabilityModule,
): Promise<TableGenerationMembers> {
  return loadTableGroup("generation", loader);
}
