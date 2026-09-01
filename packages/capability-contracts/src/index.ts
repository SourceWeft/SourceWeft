import { z } from "zod";
import { capabilityPipelineSchema } from "./deliverable-pipeline";

export * from "./deliverable-pipeline";

export const capabilityDiagnosticLevelSchema = z.enum([
  "error",
  "warning",
  "info",
]);

/**
 * Every member here must have a producer.
 *
 * The value of an enum member is that exhaustiveness checking forces callers to
 * handle it; a member nothing ever emits forces nothing, so it buys no safety
 * and only implies a reporting path that does not exist. Add a code in the same
 * change that starts emitting it.
 *
 * Note that entry-module load failures are reported via `logger.warn` rather
 * than as a diagnostic, so they are not a reserved code here either.
 */
export const capabilityDiagnosticCodeSchema = z.enum([
  "manifest.invalid",
  "path.escape",
]);

export const capabilityKindSchema = z.enum([
  "skill",
  "tool",
  "vfs",
  "retrieval",
  "document_parser",
  "connector",
  "composite",
]);

/**
 * Host-level services a capability supplies an implementation for.
 *
 * Distinct from a contribution: a contribution is something the *agent* can
 * reach (a tool, a skill), whereas a host service is something the *host* runs
 * on. Declaring it here is what lets the host find the implementation without
 * naming the package — it loads the entry module of every capability that
 * declares the service and calls the matching factory in
 * `@sourceweft/contracts/capability-host-services`.
 *
 * Connector adapters are deliberately absent: a connector capability already
 * declares itself through its `connectors` contributions, so re-declaring it
 * here would be a second source of truth for the same fact.
 *
 * A service is either resolve-one or collect-many, and which one it is belongs
 * to the host that consumes it, not to this list:
 *  - `web_provider` is resolve-one — the host has a single web port, so the
 *    first declaring capability wins and a second is logged and ignored.
 *  - `sandbox_provider` is collect-many keyed by provider id — the host picks
 *    by configured id, so several providers must be able to coexist, and two
 *    capabilities claiming the same id is a startup failure rather than a
 *    silent shadowing.
 */
export const capabilityHostServiceSchema = z.enum([
  "web_provider",
  "sandbox_provider",
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

export const CAPABILITY_COMMAND_TOOL_POLICY_MAX_IDS = 256;

const uniqueContributionIdsSchema = z
  .array(contributionIdSchema)
  .max(CAPABILITY_COMMAND_TOOL_POLICY_MAX_IDS)
  .superRefine((values, context) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate tool id '${value}'`,
          path: [index],
        });
      }
      seen.add(value);
    });
  });

/**
 * How the first model call enters a command. Omitted is deliberately distinct
 * from `auto`: compatibility consumers may retain their legacy forced-tool
 * behavior until a manifest opts into automatic tool looping.
 */
export const capabilityInitialToolPolicySchema = z.union([
  z.literal("auto"),
  z
    .object({
      kind: z.literal("force"),
      toolName: contributionIdSchema,
    })
    .strict(),
]);

/**
 * Capability-declared command tool surface. `allow` omitted means no allowlist;
 * an explicitly empty `allow` means allow none. Deny always wins, and overlap
 * is rejected at manifest load rather than left to backend precedence rules.
 */
export const capabilityCommandToolPolicySchema = z
  .object({
    allow: uniqueContributionIdsSchema.optional(),
    deny: uniqueContributionIdsSchema.default([]),
  })
  .strict()
  .superRefine((policy, context) => {
    if (!policy.allow) return;
    const denied = new Set(policy.deny);
    policy.allow.forEach((toolName, index) => {
      if (denied.has(toolName)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Tool '${toolName}' cannot be both allowed and denied`,
          path: ["allow", index],
        });
      }
    });
  });

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

/**
 * What completing this command produces. Note there is no `tool_call` variant:
 * a command whose success is "the tool ran" declares `none`. The `tool_call`
 * *success criteria* still exists downstream — the backend derives it when an
 * artifact output names an artifactType it has no renderer for.
 */
export const capabilityRuntimeOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("artifact"),
    artifactType: z.string().min(1),
    publisherTool: contributionIdSchema,
  }),
]);

export const capabilityCommandWorkflowSchema = z
  .object({
    execution: z.literal("agent"),
    initialToolPolicy: capabilityInitialToolPolicySchema.optional(),
    toolPolicy: capabilityCommandToolPolicySchema.optional(),
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
  })
  .superRefine((workflow, context) => {
    const initial = workflow.initialToolPolicy;
    if (!initial || initial === "auto" || !workflow.toolPolicy) return;
    if (workflow.toolPolicy.deny.includes(initial.toolName)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Forced initial tool '${initial.toolName}' is denied by toolPolicy`,
        path: ["initialToolPolicy", "toolName"],
      });
    }
    if (
      workflow.toolPolicy.allow &&
      !workflow.toolPolicy.allow.includes(initial.toolName)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Forced initial tool '${initial.toolName}' is absent from toolPolicy.allow`,
        path: ["initialToolPolicy", "toolName"],
      });
    }
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
  /**
   * "The values I can offer depend on the selected model." `key` names the
   * model-catalog annotation this capability contributes (see
   * `AgentToolModelCatalogAnnotation` in @sourceweft/contracts) and `path` is a
   * dotted path inside it to the array of values that model supports.
   *
   * Declared here so the option itself carries the rule. The client resolving
   * it — the composer's option picker — then narrows any option the same way,
   * instead of carrying one hardcoded branch per capability that happens to
   * have model-constrained options.
   */
  modelValues: z
    .object({
      key: z.string().min(1),
      path: z.string().min(1),
    })
    .strict()
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

export const capabilityRuntimeSchema = z
  .object({
    execution: z.literal("agent").default("agent"),
    initialToolPolicy: capabilityInitialToolPolicySchema.optional(),
    toolPolicy: capabilityCommandToolPolicySchema.optional(),
    promptIntro: z.string().min(1).optional(),
    tools: z.array(contributionIdSchema).default([]),
    permissionOverrides: z
      .record(z.string(), capabilityToolPermissionSchema)
      .default({}),
    output: capabilityRuntimeOutputSchema.optional(),
    /**
     * Declares that this tool produces its artifact via a background worker
     * pipeline. The worker host registers the job name and loads the package's
     * createDeliverablePipelines factory.
     */
    pipeline: capabilityPipelineSchema.optional(),
    requiredArguments: z
      .object({
        description: z.string().min(1),
        clarificationPrompt: z.string().min(1),
      })
      .optional(),
    additionalPromptLines: z.array(z.string().min(1)).default([]),
  })
  .superRefine((runtime, context) => {
    const initial = runtime.initialToolPolicy;
    if (!initial || initial === "auto" || !runtime.toolPolicy) return;
    if (runtime.toolPolicy.deny.includes(initial.toolName)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Forced initial tool '${initial.toolName}' is denied by toolPolicy`,
        path: ["initialToolPolicy", "toolName"],
      });
    }
    if (
      runtime.toolPolicy.allow &&
      !runtime.toolPolicy.allow.includes(initial.toolName)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Forced initial tool '${initial.toolName}' is absent from toolPolicy.allow`,
        path: ["initialToolPolicy", "toolName"],
      });
    }
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
  // Turn selection only. Visibility remains a catalog/access concern.
  defaultEnabled: z.boolean().optional(),
  // Market surfacing (orthogonal to `visibility`, which stays a scope/gate concept):
  // `listing` decides whether the skill appears in the market at all; `managed`
  // decides whether it is installable/uninstallable per workspace (false = always-on).
  listing: z.enum(["listed", "hidden"]).default("listed"),
  managed: z.boolean().default(false),
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
  skills: z.array(skillContributionSchema).default([]),
  tools: z.array(toolContributionSchema).default([]),
  vfs: z.array(vfsContributionSchema).default([]),
  retrieval: z.array(retrievalContributionSchema).default([]),
  documentParsers: z.array(documentParserContributionSchema).default([]),
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
  skills: z.array(skillContributionSchema).optional(),
  tools: z.array(toolContributionSchema).optional(),
  vfs: z.array(vfsContributionSchema).optional(),
  retrieval: z.array(retrievalContributionSchema).optional(),
  documentParsers: z.array(documentParserContributionSchema).optional(),
  connectors: z.array(connectorContributionSchema).optional(),
  hostServices: z.array(capabilityHostServiceSchema).default([]),
  configSchema: jsonObjectSchema.default({}),
});

const contributionFieldByKind = {
  connector: "connectors",
  document_parser: "documentParsers",
  retrieval: "retrieval",
  skill: "skills",
  tool: "tools",
  vfs: "vfs",
} as const;

const topLevelContributionFields = [
  "skills",
  "tools",
  "vfs",
  "retrieval",
  "documentParsers",
  "connectors",
] as const;

export const capabilityManifestSchema = baseCapabilityManifestSchema
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
      skills: manifest.skills ?? [],
      tools: manifest.tools ?? [],
      vfs: manifest.vfs ?? [],
      retrieval: manifest.retrieval ?? [],
      documentParsers: manifest.documentParsers ?? [],
      connectors: manifest.connectors ?? [],
    },
  }));

export const capabilityDiagnosticSchema = z.object({
  level: capabilityDiagnosticLevelSchema,
  code: capabilityDiagnosticCodeSchema,
  message: z.string().min(1),
  source: z.string().optional(),
  capabilityId: z.string().optional(),
});

export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;
/** Shape authors write in a manifest, before parsing applies defaults. */
export type CapabilityManifestInput = z.input<typeof capabilityManifestSchema>;
export type CapabilityDiagnostic = z.infer<typeof capabilityDiagnosticSchema>;
export type CapabilityDiagnosticCode = z.infer<
  typeof capabilityDiagnosticCodeSchema
>;
export type CapabilityCommandWorkflow = z.infer<
  typeof capabilityCommandWorkflowSchema
>;
export type CapabilityInitialToolPolicy = z.infer<
  typeof capabilityInitialToolPolicySchema
>;
export type CapabilityCommandToolPolicy = z.infer<
  typeof capabilityCommandToolPolicySchema
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
export type RetrievalContribution = z.infer<typeof retrievalContributionSchema>;
export type DocumentParserContribution = z.infer<
  typeof documentParserContributionSchema
>;
export type ConnectorContribution = z.infer<typeof connectorContributionSchema>;
export type ConnectorActionContribution = z.infer<typeof connectorActionSchema>;
export type ConnectorActionRisk = z.infer<typeof connectorActionRiskSchema>;
export type CapabilityHostService = z.infer<typeof capabilityHostServiceSchema>;

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
