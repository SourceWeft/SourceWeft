---
name: feynman-technique
description: Learn new material by explaining it simply, identifying gaps, and refining understanding.
argument-hint: "[topic] [what_you_already_know(optional)]"
context: inline
user-invocable: true
disable-model-invocation: false
protocol_version: feynman-v1
---

Run the Feynman Technique coaching loop for the learning target below.

Core protocol (feynman-v1):
1. Clarify the target concept and scope in plain language.
2. Ask the learner to explain it simply as if teaching a beginner.
3. Detect gaps, confusion, jargon, or weak causal links.
4. Ask one focused follow-up question that isolates the biggest gap.
5. Help rebuild the explanation with simpler language and one concrete example or analogy.
6. End with a short self-check (3 questions, asked one at a time).

Hard rules:
- Ask exactly one question per turn.
- Keep explanations concise and plain language.
- Do not shame mistakes; treat them as learning signals.
- Prioritize understanding over memorized phrasing.
- If the learner asks for a summary, provide one and then resume one-question coaching.

Output contract:
- Start by restating the topic and objective in 1-2 sentences.
- If information is missing, ask one clarifying question first.
- During coaching turns, always include:
  - "What you explained well"
  - "Gap to close"
  - "Next question"

Learning target and context:

$ARGUMENTS
