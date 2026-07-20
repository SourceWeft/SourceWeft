import type {
  ArtifactAssetLocation,
  ArtifactViewHandler,
  ArtifactViewRecord,
} from "@sourceweft/contracts";
import type { AgentToolDefinitionShape } from "@sourceweft/contracts/agent-tools";
import type { ArtifactToolRuntimePromptProvider } from "../modules/threads/agent/prompts/tool-prompt-provider";

/**
 * A capability that exists only for the host's tests.
 *
 * Backend tests used to reach for a real capability whenever they needed
 * something shaped like a capability — the image tool's prompt provider, the
 * deck publisher's factory, the video pipeline's view handler. That coupled
 * every one of those tests to a package whose behaviour they were not testing:
 * a copy edit in a capability's prompt broke a host test, and removing a
 * capability broke the host's build, so the boundary the host claims to have
 * could never actually be demonstrated.
 *
 * Everything here is deliberately inert and obviously fake. Its ids, tool names
 * and artifact types are not any real capability's, so a host behaviour that
 * only works for a particular capability's names fails against this fixture —
 * which is the point. Nothing here should ever grow a behaviour worth asserting
 * on its own; if a test needs a real capability's behaviour, that test belongs
 * in that capability's package.
 */

export const SYNTHETIC_CAPABILITY_PACKAGE_NAME =
  "@sourceweft/test-synthetic-capability";
export const SYNTHETIC_CAPABILITY_ID = "sourceweft-test/synthetic";
export const SYNTHETIC_TOOL_NAME = "synthetic_capability_tool";
export const SYNTHETIC_SKILL_ID = "synthetic-skill";
export const SYNTHETIC_PIPELINE_JOB_NAME = "synthetic-deliverable";

/** An artifact type the host serves generically, from a stored file. */
export const SYNTHETIC_FILE_ARTIFACT_TYPE = "synthetic_file_artifact";
/** An artifact type a capability takes over and the client renders. */
export const SYNTHETIC_TAKEOVER_ARTIFACT_TYPE = "synthetic_takeover_artifact";
export const SYNTHETIC_FILE_EXTENSION = ".synthetic";

/**
 * Stands in for a publisher-style handler: it renames the artifact's own
 * stored file, and nothing else. Exercises the host's "ask the handler first,
 * fall back to the payload" path without depending on any real file format.
 */
export function createSyntheticFileArtifactViewHandler(
  overrides: Partial<ArtifactViewHandler> = {},
): ArtifactViewHandler {
  return {
    artifactType: SYNTHETIC_FILE_ARTIFACT_TYPE,
    resolveFileName: ({ artifact }: { artifact: ArtifactViewRecord }) => {
      const title = artifact.title?.trim();
      return title ? `${title}${SYNTHETIC_FILE_EXTENSION}` : null;
    },
    ...overrides,
  };
}

/**
 * Stands in for a takeover handler: no single downloadable file, sub-assets
 * addressed by name out of the payload. Exercises the host's
 * `canRenderClientSide` and asset-delegation paths.
 */
export function createSyntheticTakeoverArtifactViewHandler(
  overrides: Partial<ArtifactViewHandler> = {},
): ArtifactViewHandler {
  return {
    artifactType: SYNTHETIC_TAKEOVER_ARTIFACT_TYPE,
    resolveAsset: ({
      artifact,
      fileName,
    }: {
      artifact: ArtifactViewRecord;
      fileName: string;
    }): ArtifactAssetLocation | null => {
      const payload = artifact.payloadJson;
      if (!payload || typeof payload !== "object") {
        return null;
      }
      const assets = (payload as { syntheticAssets?: unknown }).syntheticAssets;
      if (!Array.isArray(assets)) {
        return null;
      }
      for (const entry of assets) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const asset = entry as Record<string, unknown>;
        if (asset.fileName !== fileName || typeof asset.storageKey !== "string") {
          continue;
        }
        return {
          contentType:
            typeof asset.mimeType === "string"
              ? asset.mimeType
              : "application/octet-stream",
          fileName,
          storageBucket: artifact.storageBucket,
          storageKey: asset.storageKey,
        };
      }
      return null;
    },
    ...overrides,
  };
}

/**
 * A runtime prompt provider whose output is a marker, not prose. Host tests
 * assert that provider lines reach the assembled prompt; what a real
 * capability chooses to say is that capability's test to write.
 */
export function createSyntheticRuntimePromptProvider(
  lines: readonly string[] = [SYNTHETIC_PROMPT_MARKER],
): ArtifactToolRuntimePromptProvider {
  return {
    buildLines: () => [...lines],
  };
}

export const SYNTHETIC_PROMPT_MARKER = "<synthetic_capability_prompt/>";

/**
 * A discovery record shaped like the ones `discoverCapabilities` returns.
 * Typed loosely on purpose: different hosts narrow the record to the subset
 * they read, and pinning this to one host's view would make it useless to the
 * others.
 */
export function createSyntheticCapabilityRecord(overrides?: {
  packageName?: string | null;
  toolId?: string;
  jobName?: string | null;
  hostServices?: readonly string[];
}) {
  const toolId = overrides?.toolId ?? SYNTHETIC_TOOL_NAME;
  const jobName =
    overrides?.jobName === undefined
      ? SYNTHETIC_PIPELINE_JOB_NAME
      : overrides.jobName;
  return {
    packageName:
      overrides?.packageName === undefined
        ? SYNTHETIC_CAPABILITY_PACKAGE_NAME
        : overrides.packageName,
    rootDir: "/synthetic/capability",
    manifestPath: "/synthetic/capability/sourceweft.capability.json",
    manifest: {
      schemaVersion: 1 as const,
      id: SYNTHETIC_CAPABILITY_ID,
      kind: "tool" as const,
      name: "Synthetic Capability",
      version: "0.0.0",
      entry: "./src/index.ts",
      hostServices: overrides?.hostServices ?? [],
      configSchema: {},
      contributes: {
        skills: [],
        tools: [
          {
            id: toolId,
            title: "Synthetic Capability Tool",
            description: "A tool that exists only for host tests.",
            inputSchema: {},
            outputSchema: {},
            risk: "read" as const,
            options: [],
            ...(jobName
              ? {
                  runtime: {
                    execution: "agent" as const,
                    tools: [],
                    permissionOverrides: {},
                    additionalPromptLines: [],
                    pipeline: { jobName, queue: "deliverables" as const },
                  },
                }
              : {}),
          },
        ],
        vfs: [],
        retrieval: [],
        documentParsers: [],
        connectors: [],
      },
    },
  };
}

/** The connector type a synthetic connector capability claims. */
export const SYNTHETIC_CONNECTOR_TYPE = "synthetic_service";
export const SYNTHETIC_CONNECTOR_READ_TOOL = "search_synthetic_records";
export const SYNTHETIC_CONNECTOR_WRITE_TOOL = "create_synthetic_record";
export const SYNTHETIC_CONNECTOR_DELETE_TOOL = "delete_synthetic_record";

/**
 * Connector agent tools, as a real connector capability would declare them.
 *
 * The host derives a tool's connector type by elimination — the one capability
 * tag that is not a generic `connector_*` verb — so the synthetic set has to
 * carry a type tag alongside generic ones for that logic to be exercised at
 * all. That is the host behaviour under test; which connector it happens to be
 * is not.
 */
export const syntheticConnectorAgentToolDefs: readonly AgentToolDefinitionShape[] =
  [
    {
      id: "synthetic-connector-search",
      name: SYNTHETIC_CONNECTOR_READ_TOOL,
      domain: "connector",
      capabilities: ["connector", "connector_read", SYNTHETIC_CONNECTOR_TYPE],
      activation: {
        default: "off",
        userControl: "enable-disable",
        skill: { declarable: true, activates: true },
      },
    },
    {
      id: "synthetic-connector-create",
      name: SYNTHETIC_CONNECTOR_WRITE_TOOL,
      domain: "connector",
      capabilities: ["connector", "connector_create", SYNTHETIC_CONNECTOR_TYPE],
      activation: {
        default: "off",
        userControl: "enable-disable",
        skill: { declarable: true, activates: true },
      },
    },
    {
      id: "synthetic-connector-delete",
      name: SYNTHETIC_CONNECTOR_DELETE_TOOL,
      domain: "connector",
      capabilities: ["connector", "connector_delete", SYNTHETIC_CONNECTOR_TYPE],
      activation: {
        default: "off",
        userControl: "enable-disable",
        skill: { declarable: true, activates: true },
      },
    },
  ];
