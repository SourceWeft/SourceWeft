import type { LucideIcon } from "lucide-react";
import {
  Blocks,
  BookOpenText,
  BrainCircuit,
  ClipboardCheck,
  DatabaseZap,
  FileStack,
  Network,
  Radar,
} from "lucide-react";

export type BlogCategory =
  | "Updates"
  | "Guides"
  | "Research Ops"
  | "AI Engineering"
  | "Customers";

export type BlogSection = {
  heading: string;
  body: string[];
  bullets?: string[];
};

export type BlogPost = {
  slug: string;
  title: string;
  description: string;
  category: BlogCategory;
  author: string;
  date: string;
  readTime: string;
  heroLabel: string;
  visual: BlogVisualKind;
  accent: BlogAccent;
  icon: LucideIcon;
  tags: string[];
  sections: BlogSection[];
};

export type BlogVisualKind =
  | "citation-map"
  | "corpus-grid"
  | "team-stream"
  | "eval-board"
  | "ingestion-stack"
  | "memory-index"
  | "private-eval"
  | "agent-trail";

export type BlogAccent = "emerald" | "cyan" | "amber" | "rose" | "violet";

export const blogCategories = [
  "All Posts",
  "Updates",
  "Guides",
  "Research Ops",
  "AI Engineering",
  "Customers",
] as const;

export const blogPosts: BlogPost[] = [
  {
    slug: "source-grounded-answers-users-can-audit",
    title: "Designing source-grounded answers users can audit",
    description:
      "A practical framework for answers that cite the right files, reveal uncertainty, and let teams retrace every conclusion.",
    category: "AI Engineering",
    author: "Maya Chen",
    date: "May 14, 2026",
    readTime: "8 min read",
    heroLabel: "Field notes",
    visual: "citation-map",
    accent: "emerald",
    icon: BrainCircuit,
    tags: ["Citations", "Trust", "RAG"],
    sections: [
      {
        heading: "Auditability starts before generation",
        body: [
          "The answer users see is only the last mile. The real trust work happens earlier: how sources are chunked, how retrieval explains itself, and how much context survives the trip into the model.",
          "A good AI workspace treats evidence as a first-class interface object. Every answer should carry enough context for a teammate to ask: what was used, what was skipped, and what would change the result?",
        ],
      },
      {
        heading: "Use citations as controls, not decoration",
        body: [
          "Inline citations are most useful when they behave like controls. They should open the exact source, highlight the supporting passage, and show whether the passage was retrieved directly or arrived through a related note.",
          "This turns citations from a compliance flourish into a navigation system for reasoning. Users can inspect the path without leaving the flow of reading.",
        ],
        bullets: [
          "Prefer passage-level citations over file-level citations.",
          "Show source freshness when the document can change.",
          "Keep unsupported claims visually distinct from grounded claims.",
        ],
      },
      {
        heading: "Make uncertainty visible",
        body: [
          "Teams do not need every answer to be perfectly confident. They need to know when the system is guessing. We expose weak retrieval, conflicting sources, and missing context as part of the answer frame.",
          "That small act changes user behavior. Instead of treating the assistant as an oracle, people learn to treat it as a research partner with a visible working memory.",
        ],
      },
      {
        heading: "Design the review loop",
        body: [
          "The best source-grounded systems make correction cheap. A user should be able to remove a source, pin a stronger one, or ask the model to regenerate around a narrower evidence set.",
          "When the review loop is built into the interface, quality improves without asking teams to become prompt engineers.",
        ],
      },
    ],
  },
  {
    slug: "build-a-personal-research-corpus",
    title: "A practical guide to building a personal research corpus",
    description:
      "How to gather PDFs, web captures, notes, and transcripts into a corpus that stays searchable months later.",
    category: "Guides",
    author: "Theo Park",
    date: "May 7, 2026",
    readTime: "6 min read",
    heroLabel: "Guide",
    visual: "corpus-grid",
    accent: "cyan",
    icon: FileStack,
    tags: ["Research", "Files", "Workflow"],
    sections: [
      {
        heading: "Start with retrieval goals",
        body: [
          "A corpus is more useful when it is designed around future questions. Before importing everything, write down the decisions, briefs, or recurring tasks the collection should support.",
          "That list becomes the filter for naming, grouping, and metadata. The goal is not a perfect archive. The goal is a body of material that answers the questions you actually ask.",
        ],
      },
      {
        heading: "Normalize the messy edges",
        body: [
          "PDFs, notes, transcripts, and links all carry different structure. Normalize titles, owners, dates, and source types early so search results are easy to compare.",
          "Do not over-index on folders. Lightweight tags usually survive changing projects better than a deep hierarchy.",
        ],
        bullets: [
          "Keep original filenames but add human-readable titles.",
          "Tag source intent: reference, meeting, draft, dataset, decision.",
          "Mark stale sources instead of deleting them too quickly.",
        ],
      },
      {
        heading: "Write for your future assistant",
        body: [
          "Short summaries help humans scan, but they also help retrieval. Add a one-paragraph abstract to important sources when the original document has a vague title or weak structure.",
          "The best summaries include who created the source, why it matters, and what decisions it can support.",
        ],
      },
    ],
  },
  {
    slug: "notebook-workflows-for-slack-and-drive-teams",
    title: "Notebook workflows for teams that live in Slack and Drive",
    description:
      "A lightweight operating model for turning scattered messages and shared files into reusable team knowledge.",
    category: "Research Ops",
    author: "Nina Alvarez",
    date: "Apr 29, 2026",
    readTime: "7 min read",
    heroLabel: "Workflow",
    visual: "team-stream",
    accent: "amber",
    icon: Network,
    tags: ["Teams", "Slack", "Drive"],
    sections: [
      {
        heading: "Capture decisions where they happen",
        body: [
          "Most teams already have a knowledge system. It is just split across message threads, shared folders, and personal notes. The first workflow win is capturing decisions without forcing everyone into a new ritual.",
          "A notebook workspace can subscribe to the channels and folders where decisions happen, then pull durable context into one place.",
        ],
      },
      {
        heading: "Separate signal from chatter",
        body: [
          "Not every message deserves to become knowledge. Use a simple triage rule: import the artifacts, summaries, and decisions that someone will want to cite later.",
          "That keeps the workspace useful for analysis rather than turning it into another noisy archive.",
        ],
        bullets: [
          "Capture project kickoff docs and final decisions.",
          "Link back to threads instead of importing every reply.",
          "Promote recurring questions into shared notebook entries.",
        ],
      },
      {
        heading: "Close the loop in the source tools",
        body: [
          "The strongest adoption pattern is circular. Ask questions in the notebook, cite the answer, then send the resulting brief back to Slack or Drive where the team already works.",
          "That makes the workspace feel like leverage, not another destination.",
        ],
      },
    ],
  },
  {
    slug: "what-to-measure-before-adding-another-model",
    title: "What to measure before you add another model",
    description:
      "Latency, grounding quality, cost, and fallback behavior matter more than a leaderboard score once a workflow is in production.",
    category: "AI Engineering",
    author: "Jon Bell",
    date: "Apr 22, 2026",
    readTime: "5 min read",
    heroLabel: "Benchmarks",
    visual: "eval-board",
    accent: "rose",
    icon: ClipboardCheck,
    tags: ["Evaluation", "Models", "Ops"],
    sections: [
      {
        heading: "Measure the workflow, not the model",
        body: [
          "A model benchmark rarely describes the thing your users experience. In a source-grounded workspace, retrieval, context shaping, tool calls, and answer formatting all influence quality.",
          "Before adding another provider, capture the end-to-end metrics that reflect the job your team is hiring the system to do.",
        ],
      },
      {
        heading: "Define a failure budget",
        body: [
          "Some tasks can tolerate slower answers if the citations are excellent. Others need fast drafts that humans will edit. The right model depends on the failure modes you can absorb.",
          "A failure budget makes tradeoffs explicit before cost and latency creep into every conversation.",
        ],
        bullets: [
          "Track answer usefulness, citation precision, latency, and cost together.",
          "Keep a small golden set of real team questions.",
          "Test fallback paths, not just happy paths.",
        ],
      },
      {
        heading: "Prefer routing over permanent bets",
        body: [
          "Once you can measure the workflow, model choice becomes a routing problem. Use smaller models for summarization, stronger models for synthesis, and deterministic tools for extraction whenever possible.",
          "That approach is less glamorous than a single universal model, but it is easier to debug and cheaper to operate.",
        ],
      },
    ],
  },
  {
    slug: "from-pdfs-to-cited-briefs",
    title: "From PDFs to cited briefs: ingestion patterns that hold up",
    description:
      "How to parse mixed documents, preserve layout hints, and produce briefs that retain links to the original evidence.",
    category: "Guides",
    author: "Priya Raman",
    date: "Apr 15, 2026",
    readTime: "9 min read",
    heroLabel: "Deep dive",
    visual: "ingestion-stack",
    accent: "violet",
    icon: DatabaseZap,
    tags: ["PDFs", "Ingestion", "Briefs"],
    sections: [
      {
        heading: "Keep document structure alive",
        body: [
          "Good ingestion is not just text extraction. Tables, headings, captions, and page boundaries often carry the evidence users need to trust a generated brief.",
          "When that structure disappears, the model may still write something fluent, but reviewers lose the ability to verify it quickly.",
        ],
      },
      {
        heading: "Chunk around claims",
        body: [
          "Chunking by token count is a reasonable fallback, but briefs work better when chunks preserve claims, sections, and supporting context.",
          "A brief about a clinical study, board memo, or product spec needs the nearby caveats and definitions, not just the sentence that matched the query.",
        ],
        bullets: [
          "Store page and section anchors with every chunk.",
          "Keep tables separately addressable.",
          "Carry extraction confidence into retrieval metadata.",
        ],
      },
      {
        heading: "Generate with review in mind",
        body: [
          "A cited brief should be scannable. Lead with the answer, group evidence by claim, and keep source cards close to the text they support.",
          "The final artifact should make it easy for a reviewer to challenge a conclusion without redoing the whole research pass.",
        ],
      },
    ],
  },
  {
    slug: "field-guide-to-ai-workspace-memory",
    title: "A field guide to AI workspace memory",
    description:
      "The difference between chat history, durable project knowledge, and explicit user preferences in AI notebook products.",
    category: "Research Ops",
    author: "Elias Ford",
    date: "Apr 9, 2026",
    readTime: "6 min read",
    heroLabel: "Concepts",
    visual: "memory-index",
    accent: "emerald",
    icon: BookOpenText,
    tags: ["Memory", "UX", "Knowledge"],
    sections: [
      {
        heading: "Memory is not one thing",
        body: [
          "People use the word memory for several different product behaviors: chat history, project state, reusable facts, preferences, and durable knowledge sources.",
          "Blending those behaviors into one invisible bucket makes the product feel magical until something goes wrong. Separate memory types are easier to explain and easier to control.",
        ],
      },
      {
        heading: "Give memory an interface",
        body: [
          "Users should be able to see what the system remembers, where it came from, and how to remove it. That is especially important in workspaces with private files or sensitive team context.",
          "Memory becomes less scary when it has boundaries and receipts.",
        ],
        bullets: [
          "Treat explicit preferences differently from inferred facts.",
          "Scope durable memory to projects and teams.",
          "Show when a memory influenced an answer.",
        ],
      },
      {
        heading: "Design forgetting as a feature",
        body: [
          "Forgetting is not just privacy hygiene. It keeps knowledge fresh. Teams need a way to archive outdated assumptions, expire temporary context, and replace old project decisions.",
          "A workspace that forgets well can stay useful longer.",
        ],
      },
    ],
  },
  {
    slug: "evaluate-answers-when-sources-are-private",
    title: "How to evaluate answers when every source is private",
    description:
      "A testing pattern for enterprise teams that cannot send golden datasets to public benchmarks or third-party review tools.",
    category: "Customers",
    author: "Sara Malik",
    date: "Mar 28, 2026",
    readTime: "7 min read",
    heroLabel: "Customer pattern",
    visual: "private-eval",
    accent: "cyan",
    icon: Radar,
    tags: ["Enterprise", "Evaluation", "Privacy"],
    sections: [
      {
        heading: "Private data needs private evals",
        body: [
          "Enterprise teams often have the best evaluation data locked inside private documents. That data is exactly what makes benchmarks useful, and exactly what makes them hard to share.",
          "The answer is not to avoid evaluation. It is to run smaller, source-aware evals inside the same privacy boundary as the product.",
        ],
      },
      {
        heading: "Build cases from real review moments",
        body: [
          "The most useful test cases come from moments when a user checked an answer: a disputed citation, a missing caveat, a slow retrieval, or a summary that skipped the most important page.",
          "Convert those moments into repeatable questions with expected evidence, not just expected wording.",
        ],
        bullets: [
          "Store evaluation inputs without exporting sensitive documents.",
          "Grade citation support separately from writing quality.",
          "Review regressions with the source owner when possible.",
        ],
      },
      {
        heading: "Make evals part of release rhythm",
        body: [
          "Run the private set before retrieval changes, model routing changes, and prompt updates. Small eval suites become powerful when they run consistently.",
          "The goal is not perfect prediction. It is catching the changes that would surprise your users.",
        ],
      },
    ],
  },
  {
    slug: "ship-agentic-research-without-losing-the-trail",
    title: "Shipping agentic research without losing the trail",
    description:
      "How to design multi-step research workflows that preserve tool calls, intermediate notes, and final citations.",
    category: "Updates",
    author: "Cal Rivera",
    date: "Mar 19, 2026",
    readTime: "8 min read",
    heroLabel: "Product update",
    visual: "agent-trail",
    accent: "amber",
    icon: Blocks,
    tags: ["Agents", "Research", "Trace"],
    sections: [
      {
        heading: "Agents need a readable trail",
        body: [
          "Agentic research can cover more ground than a single prompt, but it also creates more places for context to disappear. Tool calls, rejected sources, intermediate notes, and final citations all matter.",
          "A readable trail gives users confidence that the agent did useful work instead of simply arriving with a polished answer.",
        ],
      },
      {
        heading: "Expose the research shape",
        body: [
          "Users do not need every token of chain-of-thought. They need the shape of the work: which sources were searched, what criteria were used, what was kept, and what was discarded.",
          "The interface should compress the trail into milestones that can be expanded when a reviewer needs more detail.",
        ],
        bullets: [
          "Group tool calls by research phase.",
          "Show why sources were selected or rejected.",
          "Attach final claims to both notes and original documents.",
        ],
      },
      {
        heading: "Make reruns intentional",
        body: [
          "A research agent should support reruns with changed constraints: newer sources, stricter evidence, or a narrower project scope.",
          "When reruns are visible and comparable, teams can improve the output without losing the prior reasoning trail.",
        ],
      },
    ],
  },
];

export const featuredPost = blogPosts[0] as BlogPost;

export function getBlogPost(slug: string) {
  return blogPosts.find((post) => post.slug === slug);
}

export function getRelatedPosts(currentSlug: string) {
  const currentPost = getBlogPost(currentSlug);

  if (!currentPost) {
    return blogPosts.slice(0, 3);
  }

  const sameCategory = blogPosts.filter(
    (post) => post.slug !== currentSlug && post.category === currentPost.category,
  );
  const otherPosts = blogPosts.filter(
    (post) => post.slug !== currentSlug && post.category !== currentPost.category,
  );

  return [...sameCategory, ...otherPosts].slice(0, 3);
}
