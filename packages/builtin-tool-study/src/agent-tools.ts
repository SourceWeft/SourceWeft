import {
  STUDY_ARTIFACT_TYPES,
  STUDY_LIMITS,
  studyDifficultySchema,
  studyGenerateRequestSchema,
  studySizeSchema,
  type StudyKind,
  type StudyOptions,
} from "@sourceweft/contracts/study";
import {
  bindGroundedArtifactTool,
  requestGroundedArtifactFromTurn,
  type GroundedArtifactToolBinding,
  type GroundedArtifactToolFactoryInput,
} from "@sourceweft/grounded-generation";
import { tool } from "langchain";
import { z } from "zod";
import { STUDY_TOOL_NAMES } from "./agent-tool-defs";

/**
 * `generate_flashcards`, `generate_quiz` and `generate_mindmap`: each queues a
 * study artifact over the turn's sources and returns the pending artifact. The
 * items are written by the background job, exactly as for one started from the
 * source hub — these tools never call a model, so nothing they start is billed
 * to the chat turn; the job bills the person who asked.
 */

type StudyToolText = {
  /** "flashcards", "a quiz", "a mind map". */
  readonly noun: string;
  /** Subject of "… is being generated". */
  readonly subject: string;
  /** What the agent must not make up while the job runs. */
  readonly items: string;
  readonly command: string;
  readonly what: string;
  readonly countMeaning: string;
  /** Leads the next step when an identical request a moment ago is reused. */
  readonly reused: string;
  /** The next step when that reused artifact is already ready. */
  readonly ready: string;
};

const TEXT: Record<StudyKind, StudyToolText> = {
  flashcards: {
    noun: "flashcards",
    subject: "The flashcards are",
    items: "cards",
    command: "/flashcards",
    what: "a deck of flashcards (front, back, hint) for spaced-repetition review",
    countMeaning: "number of cards",
    reused: "The same flashcards were requested a moment ago and are reused.",
    ready: "The same flashcards were requested a moment ago and are already ready.",
  },
  quiz: {
    noun: "a quiz",
    subject: "The quiz is",
    items: "questions or answers",
    command: "/quiz",
    what: "a quiz (single choice, multiple choice, true/false and short answer) the user can take and get scored on",
    countMeaning: "number of questions",
    reused: "The same quiz was requested a moment ago and is reused.",
    ready: "The same quiz was requested a moment ago and is already ready.",
  },
  mindmap: {
    noun: "a mind map",
    subject: "The mind map is",
    items: "nodes or branches",
    command: "/mindmap",
    what: "a mind map: a tree of the sources' main topics and their sub-points",
    countMeaning: "number of nodes",
    reused: "The same mind map was requested a moment ago and is reused.",
    ready: "The same mind map was requested a moment ago and is already ready.",
  },
};

const LANGUAGE_TAG = z.string().trim().min(2).max(35);

function studyToolSchema(kind: StudyKind) {
  const text = TEXT[kind];
  const common = {
    size: studySizeSchema
      .optional()
      .describe(
        `How big to make it: fewer, standard or more. Set when the user asks for "a few" or "lots"; omitted, standard.`,
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(STUDY_LIMITS.maxCount[kind])
      .optional()
      .describe(
        `Exact ${text.countMeaning}, ${STUDY_LIMITS.maxCount[kind]} at most. Set only when the user named a number; it overrides size.`,
      ),
    focus: z
      .string()
      .trim()
      .max(STUDY_LIMITS.focusChars)
      .optional()
      .describe(
        `The user's own wording of what to concentrate on (a topic, chapter or angle), ${STUDY_LIMITS.focusChars} characters at most. Never source text.`,
      ),
    language: LANGUAGE_TAG.optional().describe(
      `BCP 47 tag. Set only when the user asked for ${text.noun} in a specific language; omitted, it follows its sources.`,
    ),
    userLanguage: LANGUAGE_TAG.describe(
      "BCP 47 tag of the language the user is writing in (e.g. en, zh-CN, zh-TW). Used when the sources are in mixed languages.",
    ),
  };
  if (kind === "mindmap") return z.object(common);
  return z.object({
    ...common,
    difficulty: studyDifficultySchema
      .optional()
      .describe("easy, mixed or hard. Set when the user asks for it; omitted, mixed."),
  });
}

export const generateFlashcardsSchema = studyToolSchema("flashcards");
export const generateQuizSchema = studyToolSchema("quiz");
export const generateMindmapSchema = studyToolSchema("mindmap");

const SCHEMAS = {
  flashcards: generateFlashcardsSchema,
  quiz: generateQuizSchema,
  mindmap: generateMindmapSchema,
} as const;

type StudyToolArgs = {
  size?: StudyOptions["size"];
  count?: number;
  difficulty?: StudyOptions["difficulty"];
  focus?: string;
  language?: string;
  userLanguage: string;
};

function noSourcesMessage(kind: StudyKind) {
  const text = TEXT[kind];
  return `No sources are selected for this conversation. Ask the user to select or @mention the sources to make ${text.noun} from (in the Hub or the message), then run ${text.command} again.`;
}

function tooManySourcesMessage(
  kind: StudyKind,
  counts: { sources: number; maxSources: number },
) {
  const text = TEXT[kind];
  return `This conversation has ${counts.sources} sources, more than the ${counts.maxSources} that ${text.noun} can be made from. Ask the user to narrow the selection (or @mention the sources to use) to ${counts.maxSources} or fewer, then run ${text.command} again.`;
}

function nextStep(kind: StudyKind, receipt: { reused: boolean; status: string }) {
  const text = TEXT[kind];
  if (receipt.reused && receipt.status === "ready") {
    return `${text.ready} Tell the user it is in the Hub's Artifacts tab. Do not write, guess or summarize any ${text.items} yourself.`;
  }
  const step = `${text.subject} being generated in the background. Tell the user it will appear in the Hub's Artifacts tab when it is ready. Do not write, guess or summarize any ${text.items}: none exist yet.`;
  return receipt.reused ? `${text.reused} ${step}` : step;
}

/** Only the options the model set; an empty set is no options at all. */
function optionsOf(args: StudyToolArgs): StudyOptions | undefined {
  const focus = args.focus?.trim();
  const options: StudyOptions = {
    ...(args.size ? { size: args.size } : {}),
    ...(args.count !== undefined ? { count: args.count } : {}),
    ...(args.difficulty ? { difficulty: args.difficulty } : {}),
    ...(args.language ? { language: args.language } : {}),
    ...(focus ? { focus } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

function createStudyTool(kind: StudyKind, binding: GroundedArtifactToolBinding) {
  const text = TEXT[kind];
  return tool(
    async (args: StudyToolArgs) => {
      // The study contract decides, not this tool: the source limit and the
      // per-type item ceiling come from the same schema the app's request
      // route uses. The thread is the turn's.
      const options = optionsOf(args);
      const outcome = await requestGroundedArtifactFromTurn({
        binding,
        artifactType: kind,
        subject: kind === "mindmap" ? "mind map" : kind,
        parse: ({ threadId, sourceIds }) =>
          studyGenerateRequestSchema.safeParse({
            threadId,
            artifactType: kind,
            sourceIds,
            ...(options ? { options } : {}),
          }),
        uiLocale: args.userLanguage,
        noSourcesMessage: noSourcesMessage(kind),
        maxSources: STUDY_LIMITS.maxSources,
        tooManySourcesMessage: (counts) => tooManySourcesMessage(kind, counts),
      });
      if (!outcome.ok) return outcome;
      const { request, receipt } = outcome;
      return {
        ok: true,
        status: receipt.status,
        artifactType: kind,
        artifactId: receipt.artifactId,
        versionNo: receipt.versionNo,
        reused: receipt.reused,
        sources: request.sourceIds.length,
        nextStep: nextStep(kind, receipt),
      };
    },
    {
      name: STUDY_TOOL_NAMES[kind],
      description: `Create ${text.what} from the sources this conversation is about (the @mentioned sources, otherwise the selected ones). Every item is backed by a quote from its source. The tool reads the sources itself, so pass no source names or paths. It queues the work and returns at once; the content is generated in the background.`,
      schema: SCHEMAS[kind] as z.ZodType<StudyToolArgs>,
    },
  );
}

export function createCapabilityAgentTools(input: GroundedArtifactToolFactoryInput) {
  const tools = [];
  for (const kind of STUDY_ARTIFACT_TYPES) {
    const binding = bindGroundedArtifactTool(input, STUDY_TOOL_NAMES[kind]);
    if (!binding) continue;
    tools.push({ tool: createStudyTool(kind, binding), categories: ["artifact"] as const });
  }
  return { tools };
}
