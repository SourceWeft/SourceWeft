import assert from "node:assert/strict";
import { test } from "vitest";
import { evaluateInvocationPolicy } from "./policy-evaluator";
import type { InvocationPlan } from "./types";

function skillPlan(): InvocationPlan {
  return {
    kind: "inject_context",
    selectableId: "skill_command.research.summarize",
    sourceRef: {
      kind: "skill_command",
      skillSlug: "research",
      commandName: "summarize",
    },
    semantics: {
      kind: "context_injection",
      workflow: "Summarize sources.",
    },
    userInput: "summarize",
  };
}

test("policy evaluator denies disabled skills", () => {
  const decision = evaluateInvocationPolicy({
    plan: skillPlan(),
    skillEnabled: false,
  });

  assert.equal(decision.decision, "deny");
  assert.equal(decision.decision === "deny" ? decision.error.code : null, "SKILL_NOT_ENABLED");
});
