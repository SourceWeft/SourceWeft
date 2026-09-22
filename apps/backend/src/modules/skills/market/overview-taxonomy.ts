/** Stable classification boundaries; bump taxonomy version when these change. */
export const skillAnalysisTaxonomy = {
  "documents-office":
    "Create, edit or extract office artifacts (PDF, Word, slides, spreadsheets). Examples: format a deck, fill a PDF. Exclude statistical analysis whose deliverable is insight rather than file production.",
  "writing-content":
    "Draft, edit or translate prose. Examples: edit an essay, translate documentation. Exclude sales campaigns and operational messages when those are the main purpose.",
  "research-analysis":
    "Investigate sources, synthesize evidence and reason about a question. Examples: literature review, fact checking. Exclude numerical dataset analysis and ordinary code debugging.",
  "data-analytics":
    "Clean, query or statistically analyze datasets and visualize quantitative results. Examples: SQL analysis, statistical charts. Exclude merely producing a spreadsheet file or mentioning Python.",
  "design-creative":
    "Create visual concepts, UX, branding, illustrations, images or video. Examples: poster design, image editing. Exclude implementation-focused software work and office file formatting alone.",
  development:
    "Implement, review, test or debug software. Examples: API development, unit testing. Exclude incidental scripts supporting another deliverable, infrastructure deployment and security-focused audits.",
  "devops-cloud":
    "Deploy and operate services and infrastructure. Examples: Kubernetes deployment, CI/CD, incident operations. Exclude ordinary application coding or merely requiring cloud access.",
  "ai-agents":
    "Build or improve AI systems, agent workflows, prompts, skills or evaluations. Examples: skill authoring, RAG architecture. Exclude skills merely executed by agents or using a model as a tool.",
  "productivity-workflow":
    "Organize work, time, meetings and tasks. Examples: meeting minutes, task planning. Exclude domain-specific workflows such as deployment, tutoring or financial planning.",
  communication:
    "Prepare interpersonal, team or customer messages. Examples: support replies, internal announcements. Exclude marketing outreach and prose editing without a communication purpose.",
  "marketing-sales":
    "Attract, persuade or convert customers. Examples: SEO, campaign strategy, sales enablement. Exclude general writing, visual design or emails without a marketing objective.",
  "business-finance":
    "Support business decisions, financial, legal or administrative operations. Examples: budgets, contract review, procurement. Exclude generic data analysis without a business deliverable.",
  "learning-education":
    "Teach, tutor, explain or support study. Examples: lesson plans, Feynman explanations, quizzes. Exclude reference documentation and research without a learning objective.",
  security:
    "Assess threats, discover vulnerabilities or harden systems. Examples: threat modelling, security audits. Exclude ordinary authentication implementation and incidental credential requirements.",
  other:
    "A clearly evidenced purpose outside every category above. Example: a specialized physical-world activity with no matching category. Never use for uncertainty or missing source; use needs-review instead. No secondary category.",
} as const;

export const SKILL_ANALYSIS_CATEGORY_SLUGS = [
  "documents-office",
  "writing-content",
  "research-analysis",
  "data-analytics",
  "design-creative",
  "development",
  "devops-cloud",
  "ai-agents",
  "productivity-workflow",
  "communication",
  "marketing-sales",
  "business-finance",
  "learning-education",
  "security",
  "other",
] as const;
