import {
  bindGroundedArtifactTool,
  requestGroundedArtifactFromTurn,
  type GroundedArtifactToolFactoryInput,
} from "@sourceweft/grounded-generation";
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

export function createCapabilityAgentTools(input: GroundedArtifactToolFactoryInput) {
  const binding = bindGroundedArtifactTool(input, GENERATE_TABLE_TOOL_NAME);
  if (!binding) return { tools: [] };

  const generateTable = tool(
    async (args: GenerateTableArgs) => {
      // The table contract decides, not this tool: source and cell limits,
      // duplicates and column rules all come from the same schema the app's
      // request route uses. The thread is the turn's.
      const outcome = await requestGroundedArtifactFromTurn({
        binding,
        artifactType: TABLE_ARTIFACT_TYPE,
        subject: "table",
        parse: ({ threadId, sourceIds }) =>
          tableGenerateRequestSchema.safeParse({
            threadId,
            sourceIds,
            columns: args.columns,
            ...(args.instruction?.trim() ? { instruction: args.instruction.trim() } : {}),
            ...(args.language ? { language: args.language } : {}),
          }),
        uiLocale: args.userLanguage,
        noSourcesMessage: NO_SOURCES_MESSAGE,
      });
      if (!outcome.ok) return outcome;
      const { request, receipt } = outcome;
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
