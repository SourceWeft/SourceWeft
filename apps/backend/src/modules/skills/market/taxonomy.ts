/**
 * The skill market's categories, and the classifier that files a skill under
 * them from its name and description.
 *
 * Skills carry no category of their own (the SKILL.md frontmatter has none), so
 * this is inferred once, when a skill is first listed, and a market admin can
 * correct it afterwards. The MCP catalog has its own taxonomy
 * (`modules/market/taxonomy.ts`); the two are kept apart on purpose — "browser
 * automation" and "databases" say nothing useful about a skill.
 */

export type SkillCategoryDefinition = {
  slug: string;
  name: string;
  description: string;
};

export const SKILL_FALLBACK_CATEGORY_SLUG = "other";

/** Most categories a skill is filed under by the classifier. */
const MAX_INFERRED_CATEGORIES = 2;

// Order is the display order.
export const skillCategoryDefinitions: readonly SkillCategoryDefinition[] = [
  {
    slug: "documents-office",
    name: "Documents & Office",
    description: "Word, PowerPoint, Excel, PDF and other office files.",
  },
  {
    slug: "writing-content",
    name: "Writing & Content",
    description: "Drafting, editing, translation and content production.",
  },
  {
    slug: "research-analysis",
    name: "Research & Analysis",
    description: "Literature review, investigation and structured reasoning.",
  },
  {
    slug: "data-analytics",
    name: "Data & Analytics",
    description: "Data cleaning, SQL, statistics and visualization.",
  },
  {
    slug: "design-creative",
    name: "Design & Creative",
    description: "Visual design, branding, art, image and video work.",
  },
  {
    slug: "development",
    name: "Software Development",
    description: "Writing, reviewing, testing and debugging code.",
  },
  {
    slug: "devops-cloud",
    name: "DevOps & Cloud",
    description: "Deployment, infrastructure, CI/CD and operations.",
  },
  {
    slug: "ai-agents",
    name: "AI & Agents",
    description: "Prompting, agent workflows, MCP servers and skill authoring.",
  },
  {
    slug: "productivity-workflow",
    name: "Productivity & Workflow",
    description: "Planning, meetings, task management and personal workflow.",
  },
  {
    slug: "communication",
    name: "Communication",
    description: "Email, announcements, team and customer communication.",
  },
  {
    slug: "marketing-sales",
    name: "Marketing & Sales",
    description: "SEO, campaigns, copy, outreach and sales enablement.",
  },
  {
    slug: "business-finance",
    name: "Business & Finance",
    description: "Strategy, finance, legal and operations.",
  },
  {
    slug: "learning-education",
    name: "Learning & Education",
    description: "Teaching, tutoring, study methods and explanations.",
  },
  {
    slug: "security",
    name: "Security",
    description: "Security review, threat modelling and hardening.",
  },
  {
    slug: SKILL_FALLBACK_CATEGORY_SLUG,
    name: "Other",
    description: "Skills that do not fit another category.",
  },
];

const definitionsBySlug = new Map(
  skillCategoryDefinitions.map((definition) => [definition.slug, definition]),
);

export function getSkillCategoryDefinition(slug: string) {
  return definitionsBySlug.get(slug) ?? null;
}

export function skillCategoryId(slug: string) {
  return `skillcat_${slug}`;
}

// Latin keywords are matched on word boundaries; CJK ones as plain substrings,
// since `\b` means nothing between Han characters.
const categoryKeywords: ReadonlyArray<readonly [string, readonly RegExp[]]> = [
  [
    "documents-office",
    [
      /\b(docx?|pptx?|xlsx?|pdfs?|word documents?|powerpoint|excel|spreadsheets?|slides?|slide decks?|presentations?|office files?|csv)\b/,
      /(文档|幻灯片|演示文稿|表格|电子表格)/,
    ],
  ],
  [
    "writing-content",
    [
      // Not bare "write"/"writing": every coding skill says "write the test",
      // "before writing code". Writing as a craft names what is written.
      /\b(copy ?writ(ing|er)|technical writing|creative writing|ghostwrit\w*|writing (style|assistant|guide|skills?)|(write|writing|draft(ing)?) (an? |the )?(article|blog|essay|newsletter|email|post|report|story|docs?|documentation|copy|proposal)s?|copy ?edit(ing)?|proofread(ing)?|blog|article|essay|newsletter|translat(e|ion|ing)|rewrit(e|ing)|storytelling|documentation|changelog|release notes)\b/,
      /(写作|撰写|润色|翻译|文案|文章)/,
    ],
  ],
  [
    "research-analysis",
    [
      /\b(research|literature|investigat(e|ion)|analy[sz]e|analysis|fact[- ]check(ing)?|citations?|sources?|synthesi[sz]e|competitive|market research|due diligence|root cause)\b/,
      /(研究|调研|分析|综述)/,
    ],
  ],
  [
    "data-analytics",
    [
      /\b(data (analysis|cleaning|pipeline|science)|dataset|sql|pandas|statistics?|statistical|charts?|dashboards?|visuali[sz]ation|analytics|metrics|etl|bigquery|notebook)\b/,
      /(数据分析|数据清洗|可视化|统计)/,
    ],
  ],
  [
    "design-creative",
    [
      /\b(design(er|ing)?|brand(ing)?|typography|fonts?|posters?|canvas|art|artwork|illustrations?|gifs?|animations?|themes?|ui|ux|figma|logo|image generation|video|creative|aesthetic)\b/,
      /(设计|品牌|海报|插画|视觉|动画)/,
    ],
  ],
  [
    "development",
    [
      /\b(code|coding|programming|developers?|software development|development (branch|workflow|environment)|debug(ging)?|bug ?fix(es)?|refactor(ing)?|unit tests?|testing|tdd|test[- ]driven|failing tests?|code review|pull requests?|prs?|git|github|worktrees?|branch(es)?|merg(e|ing)|commits?|api|sdk|typescript|javascript|python|rust|golang|java|react|frontend|backend|webapp|web app|lint(ing)?|compiler|implementation)\b/,
      /(代码|编程|调试|重构|开发)/,
    ],
  ],
  [
    "devops-cloud",
    [
      /\b(devops|deploy(ment|ing)?|ci\/?cd|docker|kubernetes|k8s|terraform|aws|gcp|azure|cloudflare|infrastructure|observability|monitoring|incident|sre|release engineering)\b/,
      /(部署|运维|基础设施)/,
    ],
  ],
  [
    "ai-agents",
    [
      /\b(prompts?|prompt engineering|llms?|agents?|subagents?|mcp|model context protocol|skills?[- ]creat(or|ion|ing)|skill authoring|rag|embeddings?|fine[- ]tun(e|ing)|evals?|claude|openai|anthropic)\b/,
      /(提示词|智能体|大模型)/,
    ],
  ],
  [
    "productivity-workflow",
    [
      /\b(productivity|planning|plans?|brainstorm(ing)?|meetings?|minutes|agenda|tasks?|todo|to-do|workflow|checklists?|notes?|note-taking|calendar|scheduling|project management|okrs?)\b/,
      /(会议|纪要|计划|待办|效率|头脑风暴)/,
    ],
  ],
  [
    "communication",
    [
      /\b(emails?|internal comms?|communications?|announcements?|slack|status updates?|memos?|customer support|replies|outreach messages?|faq)\b/,
      /(邮件|沟通|公告|通知)/,
    ],
  ],
  [
    "marketing-sales",
    [
      /\b(marketing|seo|campaigns?|ad copy|advertis(ing|ement)|social media|landing pages?|sales|lead generation|go-to-market|gtm|positioning|growth)\b/,
      /(营销|推广|销售|增长)/,
    ],
  ],
  [
    "business-finance",
    [
      /\b(business|strategy|finance|financial|accounting|budget(ing)?|invoices?|contracts?|legal|compliance|pricing|quotations?|procurement|hr|recruit(ing|ment)|operations)\b/,
      /(财务|合同|法务|报价|商业|战略)/,
    ],
  ],
  [
    "learning-education",
    [
      /\b(learn(ing)?|teach(ing)?|tutor(ing)?|education(al)?|students?|study|studying|explain(er|ing)?|feynman|flashcards?|quiz(zes)?|curriculum|lessons?|courses?)\b/,
      /(学习|教学|讲解|教育|费曼)/,
    ],
  ],
  [
    "security",
    [
      /\b(security|vulnerabilit(y|ies)|threat model(l?ing)?|pen(etration)? ?test(ing)?|hardening|secrets?|owasp|cve|audit(ing)?|authentication|authorization)\b/,
      /(安全|漏洞|渗透)/,
    ],
  ],
];

/**
 * Category slugs for a skill, best match first. Every skill gets at least one:
 * a skill nothing matches is filed under `other`, so it still shows up when
 * someone browses by category.
 */
export function classifySkillCategories(input: {
  name: string;
  description: string;
}): string[] {
  const text = `${input.name} ${input.description}`.toLowerCase();
  const scored: Array<{ slug: string; score: number; order: number }> = [];
  categoryKeywords.forEach(([slug, patterns], order) => {
    let score = 0;
    for (const pattern of patterns) {
      const matches = text.match(new RegExp(pattern.source, "g"));
      score += matches?.length ?? 0;
    }
    if (score > 0) {
      scored.push({ slug, score, order });
    }
  });
  if (scored.length === 0) {
    return [SKILL_FALLBACK_CATEGORY_SLUG];
  }
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_INFERRED_CATEGORIES)
    .map((entry) => entry.slug);
}
