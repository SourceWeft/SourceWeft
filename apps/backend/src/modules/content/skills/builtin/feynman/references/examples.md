# Feynman Technique Examples

## Example 1: Understanding Kubernetes

### Step 1: Explain It Simply

**Simple Explanation**
Kubernetes is a system that manages computer programs running on many
computers.

Imagine you are running a restaurant. Instead of one chef doing everything, you
have many cooks. Kubernetes is like the head chef who decides which cook makes
which dish, replaces a cook who gets sick, and makes sure you have enough cooks
during the dinner rush.

For computer programs, Kubernetes:

- Decides which computer runs which program
- Restarts programs that crash
- Adds more copies when there is lots of demand
- Removes copies when demand drops

### Step 2: Identify Gaps

| Gap | What I Said | What I am Not Sure About |
| --- | --- | --- |
| 1 | "Many computers" | How does it know about all the computers? |
| 2 | "Runs programs" | How are programs packaged for Kubernetes? |
| 3 | "Replaces programs" | How does it know a program is unhealthy? |

### Step 3: Fill the Gaps

**Gap 1: How does it know about computers?**

- Each computer reports back to Kubernetes so the system knows what machines
  are available.
- Simple version: Each computer checks in regularly like an employee clocking
  in.

**Gap 2: How are programs packaged?**

- Programs are often packaged in containers so they can run the same way on
  different machines.
- Simple version: A container is like a meal kit with everything needed in one
  box.

**Gap 3: How does it know something is unhealthy?**

- Kubernetes checks whether a program is alive and ready to serve requests.
- Simple version: It is like a manager walking around asking whether each cook
  is okay and ready to work.

### Step 4: Refined Explanation

**Final Simple Explanation**
Kubernetes manages your programs across many computers, like a restaurant
manager overseeing multiple kitchens. It decides where programs should run,
checks whether they are healthy, replaces broken ones, and adds more when
demand increases.

---

## Example 2: Understanding Blockchain

### Step 1: Explain It Simply

A blockchain is a shared list that everyone can read but no one can secretly
change.

Imagine a classroom where everyone keeps a copy of the same notebook. Whenever
someone wants to add something, they announce it to the class. Everyone writes
it down only if they agree it is valid.

### Step 2: Identify Gaps

| Gap | What I Said | What I am Not Sure About |
| --- | --- | --- |
| 1 | "Agree it is valid" | How do they agree? |
| 2 | "Cannot secretly change" | What actually prevents changes? |
| 3 | "Shared list" | Why is it called a chain? |

### Step 3: Fill the Gaps

**Gap 1: How do they agree?**

- Systems like Bitcoin use public rules that everyone can verify.

**Gap 2: What prevents changes?**

- Each block points back to the previous block, so changing old data breaks the
  chain and becomes obvious.

**Gap 3: Why a chain?**

- Because each block links to the block before it.

### Step 4: Refined Explanation

**Final Simple Explanation**
A blockchain is a shared record book where each new page is linked to the one
before it, making secret changes very hard to hide.

---

## Common Feynman Technique Mistakes

**Mistake 1: Using jargon without noticing**

Fix: Define every technical term or replace it with simpler language.

**Mistake 2: Explaining process without meaning**

Fix: Explain why something works, not only what steps happen.

**Mistake 3: Skipping the gaps**

Fix: The weak spots are where the learning happens. Surface them clearly.
