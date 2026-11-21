import type {
  AgentToolHostServices,
  AgentToolTurnContext,
} from "@sourceweft/contracts/agent-tools";
import {
  TABLE_LIMITS,
  tableColumnInputSchema,
  tableGenerateRequestSchema,
} from "@sourceweft/contracts/table";
import { tool } from "langchain";
import { z } from "zod";
import { GENERATE_TABLE_TOOL_NAME } from "./agent-tool-defs";

/**
 * `generate_table`: queues a data table over the turn's sources and returns the
 * pending artifact. The cells are filled by the background job, exactly as for
 * a table started from the source hub — this tool never calls a model.
 */

/** What this capability asks of the host, taken out of the shared contract. */
type CapabilityAgentToolFactoryInput = {
  readonly toolIds?: readonly string[];
  readonly context?: Partial<
    Pick<AgentToolTurnContext, "isToolDenied" | "shouldBindAgentTool" | "threadId">
  >;
  readonly services?: Partial<Pick<AgentToolHostServices, "groundedArtifacts">>;
};

const TABLE_ARTIFACT_TYPE = "table";
const LANGUAGE_TAG = z.string().trim().min(2).max(35);

export const generateTableSchema = z.object({
  columns: z
    .array(tableColumnInputSchema.omit({ id: true }))
    .min(1)
    .max(TABLE_LIMITS.maxColumns)
    .describe(
      `The table's columns, in order: ${TABLE_LIMITS.maxColumns} at most. Each is one question asked of every source: a short name, a one-line description of what to extract, and a type (text, number, date or boolean).`,
    ),
  instruction: z
    .string()
    .max(TABLE_LIMITS.instructionChars)
    .optional()
    .describe("The user's own wording of what to compare, if they gave any."),
  language: LANGUAGE_TAG.optional().describe(
    "BCP 47 tag. Set only when the user asked for the table in a specific language; omitted, the table follows its sources.",
  ),
  userLanguage: LANGUAGE_TAG.describe(
    "BCP 47 tag of the language the user is writing in (e.g. en, zh-CN, zh-TW). Used when the sources are in mixed languages.",
  ),
});

type GenerateTableArgs = z.infer<typeof generateTableSchema>;

const NO_SOURCES_MESSAGE =
  "No sources are selected for this conversation. Ask the user to select or @mention the sources to compare (in the Hub or the message), then run /table again.";

const NEXT_STEP =
  "The table is being generated in the background, one source at a time. Tell the user it will appear in the Hub's Artifacts tab when it is ready. Do not state, guess or summarize any cell values: none exist yet.";

function describeIssues(error: z.ZodError) {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
    .join("; ");
}

function includesTool(input: CapabilityAgentToolFactoryInput) {
  return !input.toolIds || input.toolIds.includes(GENERATE_TABLE_TOOL_NAME);
}

export function createCapabilityAgentTools(input: CapabilityAgentToolFactoryInput) {
  const threadId = input.context?.threadId;
  const grounded = input.services?.groundedArtifacts;
  // The host hands every manifest tool id to the factory; whether this turn
  // binds the tool (the /table command or a skill selected it) is the turn's
  // call, and an unasked-for binding is a host error.
  if (
    !includesTool(input) ||
    !threadId ||
    !grounded ||
    input.context?.shouldBindAgentTool?.(GENERATE_TABLE_TOOL_NAME) !== true ||
    input.context.isToolDenied?.(GENERATE_TABLE_TOOL_NAME) === true
  ) {
    return { tools: [] };
  }

  const generateTable = tool(
    async (args: GenerateTableArgs) => {
      const sourceIds = await grounded.listTurnSourceIds();
      if (sourceIds.length === 0) {
        return { ok: false, code: "NO_SOURCES", message: NO_SOURCES_MESSAGE };
      }
      // The table contract decides, not this tool: source and cell limits,
      // duplicates and column rules all come from the same schema the app's
      // request route uses. The thread is the turn's.
      const parsed = tableGenerateRequestSchema.safeParse({
        threadId,
        sourceIds: [...sourceIds],
        columns: args.columns,
        ...(args.instruction?.trim() ? { instruction: args.instruction.trim() } : {}),
        ...(args.language ? { language: args.language } : {}),
      });
      if (!parsed.success) {
        throw new Error(`The table request is not valid: ${describeIssues(parsed.error)}`);
      }
      const { threadId: _thread, visibility: _visibility, ...request } = parsed.data;
      const receipt = await grounded.requestGeneration({
        artifactType: TABLE_ARTIFACT_TYPE,
        request,
        uiLocale: args.userLanguage,
      });
      return {
        ok: true,
        status: receipt.status,
        artifactType: TABLE_ARTIFACT_TYPE,
        artifactId: receipt.artifactId,
        versionNo: receipt.versionNo,
        reused: receipt.reused,
        sources: request.sourceIds.length,
        columns: request.columns.length,
        nextStep: receipt.reused
          ? `The same table was requested a moment ago and is reused. ${NEXT_STEP}`
          : NEXT_STEP,
      };
    },
    {
      name: GENERATE_TABLE_TOOL_NAME,
      description:
        "Create a data table that compares the sources this conversation is about (the @mentioned sources, otherwise the selected ones): one row per source, one column per question, every filled cell backed by a quote from its source. The tool reads the sources itself, so pass no source names or paths. It queues the table and returns at once; the cells are filled in the background.",
      schema: generateTableSchema,
    },
  );

  return { tools: [{ tool: generateTable, categories: ["artifact"] as const }] };
}
