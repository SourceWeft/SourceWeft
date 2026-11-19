import { HumanMessage } from "@langchain/core/messages";

/**
 * Deep Agents delivers an invoked skill's instructions by appending its
 * `SKILL.md` body to the conversation as a `HumanMessage` tagged
 * `additional_kwargs.lc_source: "pinned_skill"` (see `pinnedSkills` in the
 * skills middleware). It sits right after the user's own message, so code that
 * looks for "the latest thing the user said" must not stop at it.
 */
const PINNED_SKILL_SOURCE = "pinned_skill";

export function isPinnedSkillMessage(message: unknown): boolean {
  return (
    HumanMessage.isInstance(message) &&
    message.additional_kwargs?.lc_source === PINNED_SKILL_SOURCE
  );
}

/** A HumanMessage the user wrote, as opposed to pinned skill instructions. */
export function isUserRequestMessage(
  message: unknown,
): message is HumanMessage {
  return HumanMessage.isInstance(message) && !isPinnedSkillMessage(message);
}
