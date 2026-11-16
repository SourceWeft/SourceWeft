import { loadBuiltinCapabilityModule } from "@sourceweft/agent-tool-registry/server";
import {
  readStudyCapability,
  STUDY_CAPABILITY_FACTORY,
  StudyCapabilityUnavailableError,
  type StudyCapabilityModule,
  type StudyDerivationMembers,
  type StudyGenerationMembers,
  type StudySchedulingMembers,
} from "@sourceweft/contracts/study-capability";

/**
 * The one place the backend reaches the study capability.
 *
 * Like deliverable pipelines and artifact view handlers, the package is loaded
 * through the static module table in `@sourceweft/agent-tool-registry/server`
 * and narrowed to its contract (`@sourceweft/contracts/study-capability`); the
 * backend never imports the package. The study capability ships with the
 * backend, so a missing module or member is a deployment fault: it throws
 * `StudyCapabilityUnavailableError` instead of degrading quietly.
 */
export const STUDY_CAPABILITY_PACKAGE = "@sourceweft/builtin-tool-study";

type ModuleLoader = typeof loadBuiltinCapabilityModule;

let cached: Promise<StudyCapabilityModule> | null = null;

async function loadModule(loader: ModuleLoader) {
  const load = loader(STUDY_CAPABILITY_PACKAGE);
  if (!load) {
    throw new StudyCapabilityUnavailableError(
      `${STUDY_CAPABILITY_PACKAGE} is not in the builtin capability module table`,
    );
  }
  return readStudyCapability(await load());
}

/** Loads the module once per process and returns one required group. */
async function loadStudyGroup<G extends keyof StudyCapabilityModule>(
  group: G,
  loader: ModuleLoader,
): Promise<NonNullable<StudyCapabilityModule[G]>> {
  const usesDefault = loader === loadBuiltinCapabilityModule;
  const pending = usesDefault ? (cached ??= loadModule(loader)) : loadModule(loader);
  try {
    const capability = await pending;
    // Checked again with the requirement, so a missing group or member is
    // named in the error.
    return readStudyCapability(
      { [STUDY_CAPABILITY_FACTORY]: () => capability },
      group,
    )[group]!;
  } catch (error) {
    // A failed load is never cached: the next call tries again.
    if (usesDefault) cached = null;
    throw error;
  }
}

/** The generation engine members. */
export function loadStudyGeneration(
  loader: ModuleLoader = loadBuiltinCapabilityModule,
): Promise<StudyGenerationMembers> {
  return loadStudyGroup("generation", loader);
}

/** FSRS review scheduling, for grading flashcards. */
export function loadStudyScheduling(
  loader: ModuleLoader = loadBuiltinCapabilityModule,
): Promise<StudySchedulingMembers> {
  return loadStudyGroup("scheduling", loader);
}

/** Model-free derivations, such as quiz mistakes to flashcards. */
export function loadStudyDerivation(
  loader: ModuleLoader = loadBuiltinCapabilityModule,
): Promise<StudyDerivationMembers> {
  return loadStudyGroup("derivation", loader);
}
