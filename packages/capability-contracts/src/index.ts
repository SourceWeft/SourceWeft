import { z } from "zod";

export const capabilityDiagnosticLevelSchema = z.enum([
  "error",
  "warning",
  "info",
]);

export const capabilityDiagnosticCodeSchema = z.enum([
  "manifest.invalid",
  "path.escape",
  "duplicate.id",
  "config.invalid",
  "entry.load_failed",
  "executor.missing",
  "provider.missing",
  "writer.missing",
  "obsolete.unmigrated",
]);

export const capabilityKindSchema = z.enum([
  "skill",
  "tool",
  "vfs",
  "artifact",
  "retrieval",
  "document_parser",
  "mcp",
  "connector",
  "composite",
]);

export const capabilityRiskSchema = z.enum([
  "read",
  "write",
  "destructive",
  "unknown",
]);

export const connectorActionRiskSchema = z.enum(["low", "medium", "high"]);

export const capabilityToolPermissionSchema = z.enum(["allow", "ask", "deny"]);

export const capabilityIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u);

export const contributionIdSchema = z.string().regex(/^[a-z][a-z0-9_:-]*$/u);

const jsonObjectSchema = z.record(z.string(), z.unknown());
const optionValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const unsafeTargetPathSegments = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const capabilityOptionTargetPathSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_:-]+(?:\.[A-Za-z0-9_:-]+)*$/u)
  .refine(
    (path) =>
      path
        .split(".")
        .every((segment) => !unsafeTargetPathSegments.has(segment)),
    "Option target path contains an unsafe segment",
  );

export const capabilityCommandSuccessCriteriaSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("none") }),
    z.object({
      kind: z.literal("tool_call"),
      toolName: contributionIdSchema,
    }),
    z.object({
      kind: z.literal("artifact"),
      artifactType: z.string().min(1),
      toolName: contributionIdSchema,
    }),
  ],
);

export const capabilityRuntimeOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("tool_call"),
    toolName: contributionIdSchema,
  }),
  z.object({
    kind: z.literal("artifact"),
    artifactType: z.string().min(1),
    publisherTool: contributionIdSchema,
  }),
]);

export const capabilityCommandWorkflowSchema = z.object({
  execution: z.enum(["agent", "direct"]),
  promptIntro: z.string().min(1).optional(),
  defaultTools: z.array(contributionIdSchema).default([]),
  permissionOverrides: z
    .record(z.string(), capabilityToolPermissionSchema)
    .default({}),
  successCriteria: capabilityCommandSuccessCriteriaSchema,
  requiredArguments: z
    .object({
      description: z.string().min(1),
      clarificationPrompt: z.string().min(1),
    })
    .optional(),
  additionalPromptLines: z.array(z.string().min(1)).default([]),
});

export const capabilityCommandSchema = z.object({
  title: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).default([]),
  category: z.string().min(1).optional(),
  iconName: z
    .string()
    .regex(/^[a-z0-9-]+$/u)
    .optional(),
  iconTone: z.enum(["brand", "mono"]).optional(),
  visibleWhen: z
    .enum(["enabled", "always", "configured", "hidden"])
    .default("enabled"),
  workflow: capabilityCommandWorkflowSchema.optional(),
});

export const capabilityOptionSchema = z.object({
  id: z.string().regex(/^[a-z][A-Za-z0-9_.:-]*$/u),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  valueType: z.enum(["string", "number", "boolean"]),
  defaultValue: optionValueSchema.optional(),
  target: z
    .object({
      path: capabilityOptionTargetPathSchema,
    })
    .optional(),
  values: z
    .array(
      z.object({
        value: optionValueSchema,
        label: z.string().min(1).optional(),
      }),
    )
    .default([]),
});

export const capabilitySkillOptionSchema = capabilityOptionSchema.extend({
  target: z.object({
    toolName: contributionIdSchema.optional(),
    path: capabilityOptionTargetPathSchema,
  }),
});

export const capabilityRuntimeSchema = z.object({
  execution: z.enum(["agent", "direct"]).default("agent"),
  promptIntro: z.string().min(1).optional(),
  tools: z.array(contributionIdSchema).default([]),
  permissionOverrides: z
    .record(z.string(), capabilityToolPermissionSchema)
    .default({}),
  output: capabilityRuntimeOutputSchema.optional(),
  requiredArguments: z
    .object({
      description: z.string().min(1),
      clarificationPrompt: z.string().min(1),
    })
    .optional(),
  additionalPromptLines: z.array(z.string().min(1)).default([]),
});

export const toolContributionSchema = z.object({
  id: contributionIdSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  inputSchema: jsonObjectSchema.default({}),
  outputSchema: jsonObjectSchema.default({}),
  risk: capabilityRiskSchema.default("unknown"),
  options: z.array(capabilityOptionSchema).default([]),
  runtime: capabilityRuntimeSchema.optional(),
  command: capabilityCommandSchema.optional(),
});

export const skillContributionSchema = z.object({
  id: contributionIdSchema,
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  visibility: z.enum(["public", "restricted"]).optional(),
  categories: z.array(z.string().min(1)).default([]),
  models: z
    .object({
      chat: z.string().min(1).optional(),
      image: z.string().min(1).optional(),
      vision: z.string().min(1).optional(),
    })
    .optional(),
  options: z.array(capabilitySkillOptionSchema).default([]),
  defaultConfig: jsonObjectSchema.default({}),
  slash: z.boolean().optional(),
  slashConfig: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
  prompt: z.string().min(1).optional(),
  resources: z.array(z.string().min(1)).default([]),
  runtime: capabilityRuntimeSchema.optional(),
  command: capabilityCommandSchema.optional(),
});

export const vfsContributionSchema = z.object({
  id: contributionIdSchema,
  title: z.string().min(1),
  mounts: z.array(z.string().min(1)).default([]),
  operations: z.array(z.enum(["read", "write", "search"])).default(["read"]),
  command: capabilityCommandSchema.optional(),
});

export const artifactContributionSchema = z.object({
  id: contributionIdSchema,
  title: z.string().min(1),
  artifactTypes: z.array(z.string().min(1)).default([]),
  command: capabilityCommandSchema.optional(),
});

export const retrievalContributionSchema = z.object({
  id: contributionIdSchema,
  title: z.string().min(1),
  command: capabilityCommandSchema.optional(),
});

export const documentParserContributionSchema = z.object({
  id: contributionIdSchema,
  title: z.string().min(1),
  mimeTypes: z.array(z.string().min(1)).default([]),
  command: capabilityCommandSchema.optional(),
});

export const mcpContributionSchema = z.object({
  id: contributionIdSchema,
  title: z.string().min(1),
  command: capabilityCommandSchema.optional(),
});

export const connectorAuthSchema = z.object({
  kind: z.literal("oauth2"),
  authorizationUrl: z.string().min(1),
  tokenUrl: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  authorizationParams: z.record(z.string(), z.string()).default({}),
  sendScope: z.boolean().default(true),
});

export const connectorResourceSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  supportsDeleteDetection: z.boolean().default(false),
});

export const connectorActionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  risk: connectorActionRiskSchema,
  requiresApproval: z.boolean().default(false),
  visibility: z.enum(["agent", "internal"]).default("internal"),
  capabilities: z.array(z.string().min(1)).default([]),
  inputSchema: jsonObjectSchema.default({}),
  resultSchema: jsonObjectSchema.optional(),
  agentToolName: z.string().min(1).optional(),
});

export const connectorContributionSchema = z.object({
  id: contributionIdSchema,
  title: z.string().min(1),
  auth: connectorAuthSchema,
  sync: z.object({
    supportsIncremental: z.boolean().default(false),
    defaultFrequencyMinutes: z.number().int().positive(),
    resources: z.array(connectorResourceSchema).default([]),
  }),
  actions: z.array(connectorActionSchema).default([]),
  configSchema: jsonObjectSchema.default({}),
  command: capabilityCommandSchema.optional(),
});

export const capabilityContributesSchema = z.object({
  commands: z.array(capabilityCommandSchema).default([]),
  skills: z.array(skillContributionSchema).default([]),
  tools: z.array(toolContributionSchema).default([]),
  vfs: z.array(vfsContributionSchema).default([]),
  artifacts: z.array(artifactContributionSchema).default([]),
  retrieval: z.array(retrievalContributionSchema).default([]),
  documentParsers: z.array(documentParserContributionSchema).default([]),
  mcp: z.array(mcpContributionSchema).default([]),
  connectors: z.array(connectorContributionSchema).default([]),
});

const baseCapabilityManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: capabilityIdSchema,
  kind: capabilityKindSchema,
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  version: z.string().min(1),
  entry: z.string().min(1).optional(),
  activation: z
    .object({
      onStartup: z.boolean().default(false),
      autoEnableWhenConfigured: z.boolean().default(false),
    })
    .default({ onStartup: false, autoEnableWhenConfigured: false }),
  skills: z.array(skillContributionSchema).optional(),
  tools: z.array(toolContributionSchema).optional(),
  vfs: z.array(vfsContributionSchema).optional(),
  artifacts: z.array(artifactContributionSchema).optional(),
  retrieval: z.array(retrievalContributionSchema).optional(),
  documentParsers: z.array(documentParserContributionSchema).optional(),
  mcp: z.array(mcpContributionSchema).optional(),
  connectors: z.array(connectorContributionSchema).optional(),
  configSchema: jsonObjectSchema.default({}),
});

const contributionFieldByKind = {
  artifact: "artifacts",
  connector: "connectors",
  document_parser: "documentParsers",
  mcp: "mcp",
  retrieval: "retrieval",
  skill: "skills",
  tool: "tools",
  vfs: "vfs",
} as const;

const topLevelContributionFields = [
  "skills",
  "tools",
  "vfs",
  "artifacts",
  "retrieval",
  "documentParsers",
  "mcp",
  "connectors",
] as const;

function rejectLegacyContributesInput(
  input: unknown,
  context: z.RefinementCtx,
) {
  if (
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    "contributes" in input
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Legacy "contributes" field is not accepted; declare contribution arrays at the top level',
      path: ["contributes"],
    });
  }
}

export const capabilityManifestSchema = z
  .unknown()
  .superRefine(rejectLegacyContributesInput)
  .pipe(
    baseCapabilityManifestSchema
      .superRefine((manifest, context) => {
        if (manifest.kind === "composite") {
          return;
        }
        const allowedField = contributionFieldByKind[manifest.kind];
        for (const field of topLevelContributionFields) {
          const contributions = manifest[field];
          if (
            field !== allowedField &&
            Array.isArray(contributions) &&
            contributions.length > 0
          ) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Capability kind '${manifest.kind}' cannot declare top-level '${field}' contributions`,
              path: [field],
            });
          }
        }
      })
      .transform((manifest) => ({
        ...manifest,
        contributes: {
          commands: [],
          skills: manifest.skills ?? [],
          tools: manifest.tools ?? [],
          vfs: manifest.vfs ?? [],
          artifacts: manifest.artifacts ?? [],
          retrieval: manifest.retrieval ?? [],
          documentParsers: manifest.documentParsers ?? [],
          mcp: manifest.mcp ?? [],
          connectors: manifest.connectors ?? [],
        },
      })),
  );

export const capabilityDiagnosticSchema = z.object({
  level: capabilityDiagnosticLevelSchema,
  code: capabilityDiagnosticCodeSchema,
  message: z.string().min(1),
  source: z.string().optional(),
  capabilityId: z.string().optional(),
});

export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;
export type CapabilityManifestInput = z.input<typeof capabilityManifestSchema>;
export type CapabilityDiagnostic = z.infer<typeof capabilityDiagnosticSchema>;
export type CapabilityDiagnosticCode = z.infer<
  typeof capabilityDiagnosticCodeSchema
>;
export type CapabilityCommandWorkflow = z.infer<
  typeof capabilityCommandWorkflowSchema
>;
export type CapabilityCommandSuccessCriteria = z.infer<
  typeof capabilityCommandSuccessCriteriaSchema
>;
export type CapabilityRuntimeOutput = z.infer<
  typeof capabilityRuntimeOutputSchema
>;
export type CapabilityToolPermission = z.infer<
  typeof capabilityToolPermissionSchema
>;
export type CapabilityOption = z.infer<typeof capabilityOptionSchema>;
export type CapabilitySkillOption = z.infer<typeof capabilitySkillOptionSchema>;
export type SkillContribution = z.infer<typeof skillContributionSchema>;
export type ToolContribution = z.infer<typeof toolContributionSchema>;
export type VfsContribution = z.infer<typeof vfsContributionSchema>;
export type ArtifactContribution = z.infer<typeof artifactContributionSchema>;
export type RetrievalContribution = z.infer<typeof retrievalContributionSchema>;
export type DocumentParserContribution = z.infer<
  typeof documentParserContributionSchema
>;
export type McpContribution = z.infer<typeof mcpContributionSchema>;
export type ConnectorContribution = z.infer<typeof connectorContributionSchema>;
export type ConnectorActionContribution = z.infer<typeof connectorActionSchema>;
export type ConnectorActionRisk = z.infer<typeof connectorActionRiskSchema>;

export type ParseCapabilityManifestResult =
  | {
      readonly ok: true;
      readonly manifest: CapabilityManifest;
      readonly diagnostics: readonly [];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly CapabilityDiagnostic[];
    };

export function parseCapabilityManifest(
  input: unknown,
): ParseCapabilityManifestResult {
  const parsed = capabilityManifestSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, manifest: parsed.data, diagnostics: [] };
  }
  return {
    ok: false,
    diagnostics: [
      {
        level: "error",
        code: "manifest.invalid",
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
      },
    ],
  };
}
