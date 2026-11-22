import { defineAgentTool } from "@sourceweft/contracts/agent-tools";

/**
 * The chat entry to study artifacts: one tool per artifact type, each driven by
 * its own slash command (`/flashcards`, `/quiz`, `/mindmap`). A command names
 * exactly one tool, so one tool per type is what gives each type its own
 * command; the three share one implementation (`./agent-tools`). Each queues
 * the same generation the source hub's dialog does and returns the pending
 * artifact; none writes an item itself.
 *
 * Off by default and bound by its command (or a skill that declares it).
 * Permission and risk mirror `generate_table`, the other grounded artifact the
 * user asks for by name: it runs without a confirmation, and the job charges
 * that user.
 */
export const generateFlashcardsAgentTool = defineAgentTool({
  id: "generateFlashcards",
  name: "generate_flashcards",
  domain: "artifact",
  capabilities: ["artifact"],
  activation: {
    default: "off",
    userControl: "none",
    skill: {
      declarable: true,
      activates: true,
    },
  },
  defaultPermission: "allow",
  riskLevel: "low",
  slash: {
    aliases: ["flashcards"],
    description: "Make flashcards from the selected sources",
    displayName: "Flashcards",
    supportsCommand: true,
  },
});

export const generateQuizAgentTool = defineAgentTool({
  id: "generateQuiz",
  name: "generate_quiz",
  domain: "artifact",
  capabilities: ["artifact"],
  activation: {
    default: "off",
    userControl: "none",
    skill: {
      declarable: true,
      activates: true,
    },
  },
  defaultPermission: "allow",
  riskLevel: "low",
  slash: {
    aliases: ["quiz"],
    description: "Make a quiz from the selected sources",
    displayName: "Quiz",
    supportsCommand: true,
  },
});

export const generateMindmapAgentTool = defineAgentTool({
  id: "generateMindmap",
  name: "generate_mindmap",
  domain: "artifact",
  capabilities: ["artifact"],
  activation: {
    default: "off",
    userControl: "none",
    skill: {
      declarable: true,
      activates: true,
    },
  },
  defaultPermission: "allow",
  riskLevel: "low",
  slash: {
    aliases: ["mindmap"],
    description: "Make a mind map of the selected sources",
    displayName: "Mind Map",
    supportsCommand: true,
  },
});

/** Tool name constants — use these instead of AGENT_TOOL_NAMES */
export const GENERATE_FLASHCARDS_TOOL_NAME = generateFlashcardsAgentTool.name;
export const GENERATE_QUIZ_TOOL_NAME = generateQuizAgentTool.name;
export const GENERATE_MINDMAP_TOOL_NAME = generateMindmapAgentTool.name;

/** The tool for each study artifact type. */
export const STUDY_TOOL_NAMES = {
  flashcards: GENERATE_FLASHCARDS_TOOL_NAME,
  quiz: GENERATE_QUIZ_TOOL_NAME,
  mindmap: GENERATE_MINDMAP_TOOL_NAME,
} as const;

export const studyAgentToolDefs = [
  generateFlashcardsAgentTool,
  generateQuizAgentTool,
  generateMindmapAgentTool,
] as const;
