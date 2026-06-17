---
name: feynman
description: Use the Feynman technique to deeply learn a concept by explaining it simply, identifying gaps, filling them, and refining the explanation.
argument-hint: "[concept or question to understand]"
user-invocable: true
disable-model-invocation: false
---

# Feynman Technique

Use this skill when the user invokes `/feynman` to work through a concept with
the full Feynman learning technique.

Treat `$ARGUMENTS` as the concept, question, or topic to understand. If
`$ARGUMENTS` is empty or too vague, ask exactly one clarifying question before
continuing.

## Execution Rules

1. Run the technique end to end instead of only describing it.
2. Focus on the specific concept named in `$ARGUMENTS`.
3. Use plain language and avoid unnecessary jargon.
4. Be explicit about uncertainty or missing understanding.
5. When helpful, use a concrete analogy from everyday life.
6. Keep the result practical and easy to study from.

## Output Format

**Concept**: [What are we trying to understand?]

---

## Step 1: Explain It Simply

_Explain as if teaching someone with no background in this field._

### Simple Explanation

[Write a plain-language explanation using everyday words.]

### Analogy

[Create a familiar analogy that makes the concept easier to grasp.]

---

## Step 2: Identify Gaps

_Point out where the explanation becomes fuzzy, hand-wavy, incomplete, or too
dependent on jargon._

### Gaps Found

| Gap | What seems unclear | What needs to be understood better |
| --- | ------------------ | ---------------------------------- |
| 1   | [unclear part]     | [underlying question]              |
| 2   | [unclear part]     | [underlying question]              |
| 3   | [unclear part]     | [underlying question]              |

### Jargon Used

| Term   | Can it be explained simply? |
| ------ | --------------------------- |
| [term] | Yes / No / Partially        |

---

## Step 3: Fill the Gaps

_Resolve the biggest gaps by reasoning carefully from known facts and the
user's context. If the user provided source material, stay grounded in it._

### Gap 1: [Topic]

- **The question**: [What was unclear?]
- **The answer**: [What we now understand]
- **Simple version**: [How to explain it plainly]

Repeat for as many meaningful gaps as needed.

---

## Step 4: Refined Explanation

_Rewrite the explanation after closing the major gaps._

### Final Simple Explanation

[Improved, clearer explanation in plain language.]

### Improved Analogy

[A better analogy if one helps.]

### Key Takeaways

1. [Core insight 1]
2. [Core insight 2]
3. [Core insight 3]

---

## 30-Second Version

If someone asked for a short explanation, say:

> [A concise, plain-language version.]

## Guidance

- Do not pretend to understand parts that are still weak.
- Prefer clarity over completeness when the tradeoff matters.
- If the user is learning interactively, you may end with one focused follow-up
  question, but only after providing the full Feynman breakdown above.
