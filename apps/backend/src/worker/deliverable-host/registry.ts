import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CreateDeliverablePipelines,
  DeliverablePipelineDefinition,
} from "@sourceweft/capability-contracts";
import { BUILTIN_CAPABILITY_MODULES } from "@sourceweft/agent-tool-registry/server";
import type { Job } from "bullmq";
import { logger } from "../../shared/logger";
import {
  createDefaultDeliverableRuntimeResolver,
  type DeliverableRuntimeResolver,
} from "./context";
import { createDeliverableProcessor } from "./host";
import type { DeliverableStateLike } from "./stage-runner";

/**
 * Discovers deliverable pipelines from capability manifests
 * (runtime.pipeline on tool contributions) and builds the BullMQ processor
 * map for the deliverables queue.
 *
 * Module loading: builtin packages resolve through the shared static
 * literal-import map in shared/builtin-capability-modules.ts — see that file
 * for why the map has to exist. The variable dynamic import below remains as
 * the extension path for external capability roots that ship compiled entries.
 */

type PipelineModule = {
  createDeliverablePipelines?: CreateDeliverablePipelines;
};

const BUILTIN_PIPELINE_MODULES: Record<string, () => Promise<PipelineModule>> =
  Object.fromEntries(
    Object.entries(BUILTIN_CAPABILITY_MODULES).map(([packageName, load]) => [
      packageName,
      async () => (await load()) as PipelineModule,
    ]),
  );

export type DeliverableCapabilityRecord = {
  packageName?: string | null;
  rootDir: string;
  manifest: {
    id?: string;
    entry?: string | null;
    contributes?: {
      tools?: Array<{
        id: string;
        runtime?: { pipeline?: { jobName: string } };
      }>;
    };
  };
};

export type DeliverableRecordsProvider = () => Promise<
  readonly DeliverableCapabilityRecord[]
>;

async function loadDefaultRecords(): Promise<
  readonly DeliverableCapabilityRecord[]
> {
  const module = await import(
    "../../modules/threads/turn/capability-command-workflows"
  );
  return (await module.listCapabilityRecords()) as unknown as readonly DeliverableCapabilityRecord[];
}

async function loadPipelineModule(input: {
  record: DeliverableCapabilityRecord;
  builtinModules: Record<string, () => Promise<PipelineModule>>;
}): Promise<PipelineModule | null> {
  const { record } = input;
  const builtin = record.packageName
    ? input.builtinModules[record.packageName]
    : undefined;
  if (builtin) {
    return builtin();
  }
  if (record.packageName) {
    try {
      return (await import(record.packageName)) as PipelineModule;
    } catch (error) {
      logger.warn("deliverable_pipeline_package_import_failed", {
        packageName: record.packageName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (record.manifest.entry) {
    try {
      const entryUrl = pathToFileURL(
        resolve(record.rootDir, record.manifest.entry),
      ).href;
      return (await import(entryUrl)) as PipelineModule;
    } catch (error) {
      logger.warn("deliverable_pipeline_entry_import_failed", {
        capabilityId: record.manifest.id,
        entry: record.manifest.entry,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

export async function discoverDeliverablePipelines(input?: {
  recordsProvider?: DeliverableRecordsProvider;
  builtinModules?: Record<string, () => Promise<PipelineModule>>;
}): Promise<DeliverablePipelineDefinition[]> {
  const records = await (input?.recordsProvider ?? loadDefaultRecords)();
  const builtinModules = input?.builtinModules ?? BUILTIN_PIPELINE_MODULES;
  const definitions: DeliverablePipelineDefinition[] = [];
  const seenJobNames = new Set<string>();

  for (const record of records) {
    const declaredJobNames = (record.manifest.contributes?.tools ?? [])
      .map((tool) => tool.runtime?.pipeline?.jobName)
      .filter((jobName): jobName is string => Boolean(jobName));
    if (declaredJobNames.length === 0) {
      continue;
    }

    const module = await loadPipelineModule({ record, builtinModules });
    if (!module?.createDeliverablePipelines) {
      logger.warn("deliverable_pipeline_factory_missing", {
        capabilityId: record.manifest.id,
        packageName: record.packageName,
        declaredJobNames,
      });
      continue;
    }

    const pipelines = await module.createDeliverablePipelines({
      manifest: record.manifest,
    });
    for (const declaredJobName of declaredJobNames) {
      const definition = pipelines.find(
        (pipeline) => pipeline.jobName === declaredJobName,
      );
      if (!definition) {
        logger.warn("deliverable_pipeline_declaration_unmatched", {
          capabilityId: record.manifest.id,
          jobName: declaredJobName,
          exportedJobNames: pipelines.map((pipeline) => pipeline.jobName),
        });
        continue;
      }
      if (seenJobNames.has(declaredJobName)) {
        logger.warn("deliverable_pipeline_job_name_conflict", {
          capabilityId: record.manifest.id,
          jobName: declaredJobName,
        });
        continue;
      }
      seenJobNames.add(declaredJobName);
      definitions.push(definition);
    }
  }

  return definitions;
}

type JobProcessor = (job: Job<Record<string, unknown>>) => Promise<unknown>;

export type DeliverableProcessorRegistry = {
  processors: Record<string, JobProcessor>;
  /** jobName → the pipeline's default error code, for boundary failure marking. */
  failureCodes: Record<string, string>;
  source: "discovery" | "builtin-fallback";
};

/**
 * Fallback when manifest discovery is unavailable: load every builtin module
 * directly and register whatever pipelines it exports. Keeps builtin
 * deliverables alive even if the capability packages directory cannot be
 * scanned (e.g. layout differences in a bundled deployment).
 */
async function loadBuiltinFallbackPipelines(
  builtinModules: Record<string, () => Promise<PipelineModule>>,
): Promise<DeliverablePipelineDefinition[]> {
  const definitions: DeliverablePipelineDefinition[] = [];
  const seenJobNames = new Set<string>();
  for (const [packageName, loadModule] of Object.entries(builtinModules)) {
    try {
      const module = await loadModule();
      const pipelines =
        (await module.createDeliverablePipelines?.({ manifest: null })) ?? [];
      for (const pipeline of pipelines) {
        if (seenJobNames.has(pipeline.jobName)) {
          continue;
        }
        seenJobNames.add(pipeline.jobName);
        definitions.push(pipeline);
      }
    } catch (error) {
      logger.warn("deliverable_pipeline_builtin_fallback_load_failed", {
        packageName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return definitions;
}

export async function buildDeliverableProcessorMap(input?: {
  recordsProvider?: DeliverableRecordsProvider;
  builtinModules?: Record<string, () => Promise<PipelineModule>>;
  resolveRuntime?: (definition: DeliverablePipelineDefinition) => DeliverableRuntimeResolver;
}): Promise<DeliverableProcessorRegistry> {
  const builtinModules = input?.builtinModules ?? BUILTIN_PIPELINE_MODULES;
  let definitions: DeliverablePipelineDefinition[] = [];
  let source: DeliverableProcessorRegistry["source"] = "discovery";
  try {
    definitions = await discoverDeliverablePipelines(input);
  } catch (error) {
    logger.error("deliverable_pipeline_discovery_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (definitions.length === 0) {
    // Discovery threw or legitimately found nothing — in this repo builtins
    // always ship with the backend, so an empty result means the packages
    // root was not scannable. Register builtins directly.
    definitions = await loadBuiltinFallbackPipelines(builtinModules);
    source = "builtin-fallback";
  }

  const processors: Record<string, JobProcessor> = {};
  const failureCodes: Record<string, string> = {};
  for (const definition of definitions) {
    const resolveRuntime =
      input?.resolveRuntime?.(definition) ??
      createDefaultDeliverableRuntimeResolver({
        feature: definition.billing?.feature ?? definition.id,
      });
    processors[definition.jobName] = createDeliverableProcessor(
      definition as DeliverablePipelineDefinition<DeliverableStateLike>,
      resolveRuntime,
    );
    failureCodes[definition.jobName] = definition.defaultErrorCode;
  }
  return { processors, failureCodes, source };
}
