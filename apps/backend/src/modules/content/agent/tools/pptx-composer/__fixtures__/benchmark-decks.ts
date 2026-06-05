import type { LayoutSpec, PresentationSourceV1, SlideInstruction } from "../domain/schemas";
import { basicProductOverviewFixture } from "./basic-product-overview";

type BenchmarkSlideInput = {
  readonly id: string;
  readonly role: SlideInstruction["role"];
  readonly title: string;
  readonly body: string[];
  readonly layout: LayoutSpec;
  readonly headline?: string;
  readonly visualIntent?: string;
  readonly assetRefs?: string[];
};

const palette = basicProductOverviewFixture.designSystem.palette;

export const educationIntroFixture = benchmarkDeck({
  key: "education-intro",
  title: "AI Research Methods Primer",
  subtitle: "A first lecture on grounded inquiry",
  audience: "Graduate students starting a research methods seminar",
  objective: "Introduce a repeatable framework for source-grounded research",
  primaryMessage: "Strong research starts with traceable questions, sources, and synthesis",
  language: "en",
  slideCountTarget: 5,
  slides: [
    slide("education-cover", "cover", "AI Research Methods Primer", ["Question design", "Source triage", "Synthesis loops"], coverLayout("education-cover"), {
      headline: "Turn broad curiosity into evidence-backed outputs",
    }),
    slide("education-map", "section", "From question to cited claim", ["Frame the question", "Gather relevant sources", "Compare evidence", "Write with citations"], processLayout("education-process", 4)),
    slide("education-skills", "content", "Three habits make research reusable", ["Keep source notes atomic", "Record assumptions explicitly", "Separate claims from interpretations"], threeCardsLayout("education-habits")),
    slide("education-check", "comparison", "Weak prompts and strong prompts diverge quickly", ["Ask for a summary of everything", "Ask for claims tied to named sources"], comparisonLayout("education-prompts")),
    slide("education-close", "closing", "Practice with one focused source set", ["Choose five sources", "Extract claims", "Draft a cited briefing"], closingLayout("education-close"), {
      headline: "The next assignment builds a miniature evidence map",
    }),
  ],
});

export const marketAnalysisFixture = benchmarkDeck({
  key: "market-analysis",
  title: "Knowledge Work Market Analysis",
  subtitle: "Signals for source-grounded AI workspaces",
  audience: "Product strategy and market intelligence leaders",
  objective: "Summarize market forces shaping grounded AI collaboration",
  primaryMessage: "Teams will prefer AI workspaces that preserve context, provenance, and reuse",
  language: "en",
  slideCountTarget: 5,
  assets: [{ id: "market-growth-chart", kind: "chart", purpose: "Show adoption signal", description: "Indexed line chart of team AI workspace adoption", required: false }],
  slides: [
    slide("market-cover", "cover", "Knowledge Work Market Analysis", ["Demand pull", "Workflow gaps", "Adoption signals"], coverLayout("market-cover"), {
      headline: "Grounded AI moves from assistant novelty to team infrastructure",
    }),
    slide("market-forces", "content", "Three forces are reshaping the category", ["Data sovereignty pressure", "Need for reusable workflows", "Source traceability as trust signal"], threeCardsLayout("market-forces")),
    slide("market-data", "data", "Adoption concentrates where work is source-heavy", ["Research", "Learning", "Content operations"], chartInsightLayout("market-data"), {
      visualIntent: "Chart showing rising demand in source-heavy workflows",
      assetRefs: ["market-growth-chart"],
    }),
    slide("market-choices", "comparison", "Point tools lose context between tasks", ["Single-purpose AI assistant", "Shared source-aware workspace"], comparisonLayout("market-choices")),
    slide("market-close", "closing", "Win the workflow before winning the model debate", ["Start with high-context teams", "Measure artifact reuse", "Expand by source coverage"], closingLayout("market-close"), {
      headline: "The durable wedge is repeatable grounded output",
    }),
  ],
});

export const technicalSolutionFixture = benchmarkDeck({
  key: "technical-solution",
  title: "Native PPTX Composer Architecture",
  subtitle: "Schema, QA, rendering, and repair boundaries",
  audience: "Backend engineers and architecture reviewers",
  objective: "Explain the deterministic native PPTX composition pipeline",
  primaryMessage: "The composer stays testable by separating source schemas, QA, rendering, and repair",
  language: "en",
  slideCountTarget: 5,
  assets: [{ id: "architecture-diagram", kind: "diagram", purpose: "Show composer ports", description: "Ports and adapters flow diagram", required: false }],
  slides: [
    slide("tech-cover", "cover", "Native PPTX Composer Architecture", ["Schema-first", "Renderer adapter", "QA gates"], coverLayout("tech-cover"), {
      headline: "A deterministic path for editable presentation output",
    }),
    slide("tech-boundaries", "content", "The schema is the contract between planning and rendering", ["PresentationSource v1", "LayoutSpec regions", "Asset plan references"], threeCardsLayout("tech-boundaries")),
    slide("tech-flow", "content", "Composition moves through four explicit gates", ["Validate source", "Run pre-render QA", "Render native PPTX", "Inspect OOXML"], processLayout("tech-flow", 4)),
    slide("tech-tradeoffs", "comparison", "Native editability is favored over visual flattening", ["Image-first rendering", "Editable OOXML primitives"], comparisonLayout("tech-tradeoffs")),
    slide("tech-close", "closing", "Keep runtime wiring outside the eval path", ["No network calls", "No generated artifacts", "Stable fixtures"], closingLayout("tech-close"), {
      headline: "Benchmarks should fail only on real composer regressions",
    }),
  ],
});

export const investorPitchFixture = benchmarkDeck({
  key: "investor-pitch",
  title: "SourceWeft Investor Snapshot",
  subtitle: "A concise pitch for source-grounded AI workspaces",
  audience: "Seed-stage investors evaluating knowledge work infrastructure",
  objective: "Tell a compact opportunity, product, and go-to-market story",
  primaryMessage: "Source-grounded team workspaces can become the system of record for AI-assisted knowledge work",
  language: "en",
  slideCountTarget: 6,
  assets: [{ id: "traction-chart", kind: "chart", purpose: "Show pipeline signal", description: "Synthetic traction chart for benchmark rendering", required: false }],
  slides: [
    slide("pitch-cover", "cover", "SourceWeft Investor Snapshot", ["Grounded AI", "Team workspace", "Self-hosted option"], coverLayout("pitch-cover"), {
      headline: "A source-aware workspace for serious knowledge teams",
    }),
    slide("pitch-problem", "content", "AI outputs still lose the evidence trail", ["Sources are scattered", "Answers lack provenance", "Artifacts are hard to reproduce"], threeCardsLayout("pitch-problem")),
    slide("pitch-product", "content", "The product keeps sources, chat, and artifacts together", ["Connect source sets", "Ask grounded questions", "Create reusable deliverables", "Extend with skills"], processLayout("pitch-product", 4)),
    slide("pitch-market", "data", "Demand grows fastest in high-context teams", ["Research teams", "Learning teams", "Content teams"], chartInsightLayout("pitch-market"), {
      visualIntent: "Synthetic pipeline chart with three adoption segments",
      assetRefs: ["traction-chart"],
    }),
    slide("pitch-wedge", "comparison", "The wedge is workflow ownership", ["Generic chatbot", "Source-aware team workspace"], comparisonLayout("pitch-wedge")),
    slide("pitch-close", "closing", "Invest in repeatable grounded outputs", ["Expand connectors", "Deepen evals", "Grow self-hosted teams"], closingLayout("pitch-close"), {
      headline: "The category rewards trust, context, and reuse",
    }),
  ],
});

export const dataReportFixture = benchmarkDeck({
  key: "data-report",
  title: "Quarterly Knowledge Operations Report",
  subtitle: "Operational signals for source-backed work",
  audience: "Operations leaders reviewing knowledge workflow adoption",
  objective: "Present a compact data-led status report",
  primaryMessage: "Source-backed outputs improve reuse when teams standardize workflows",
  language: "en",
  slideCountTarget: 5,
  assets: [{ id: "ops-chart", kind: "chart", purpose: "Show quarterly trend", description: "Benchmark line chart for output reuse", required: false }],
  slides: [
    slide("report-cover", "cover", "Quarterly Knowledge Operations Report", ["Usage", "Reuse", "Risks"], coverLayout("report-cover"), {
      headline: "Teams are converting source work into repeatable artifacts",
    }),
    slide("report-scorecard", "data", "Reuse increased as source sets stabilized", ["Shared artifacts grew", "Duplicate drafts fell", "Review cycles shortened"], chartInsightLayout("report-scorecard"), {
      visualIntent: "Line chart comparing source reuse and duplicate drafts",
      assetRefs: ["ops-chart"],
    }),
    slide("report-drivers", "content", "Three practices drove the improvement", ["Named workspaces", "Cited answer review", "Template-backed outputs"], threeCardsLayout("report-drivers")),
    slide("report-risks", "comparison", "The main risk is inconsistent workspace hygiene", ["Ad hoc source uploads", "Curated reusable source sets"], comparisonLayout("report-risks")),
    slide("report-close", "closing", "Standardize the next two workflows", ["Research briefings", "Launch summaries", "Training guides"], closingLayout("report-close"), {
      headline: "Operational leverage comes from repeatability",
    }),
  ],
});

export const oneSlideDeckFixture = benchmarkDeck({
  key: "one-slide-deck",
  title: "One Slide Decision Brief",
  subtitle: "A minimal benchmark deck",
  audience: "Executive reviewer with one minute",
  objective: "Render a complete deck with a single slide",
  primaryMessage: "A one-slide deck still needs editable content and no empty slide output",
  language: "en",
  slideCountTarget: 1,
  slides: [
    slide("one-slide-cover", "cover", "One Slide Decision Brief", ["Recommendation", "Reason", "Next step"], coverLayout("one-slide-cover"), {
      headline: "Approve the pilot when the source set is ready",
    }),
  ],
});

export const thirtySlideDeckFixture = benchmarkDeck({
  key: "thirty-slide-deck",
  title: "Thirty Slide Program Review",
  subtitle: "A scale benchmark for deterministic rendering",
  audience: "Program leadership reviewing a long-form operating plan",
  objective: "Exercise renderer throughput and layout diversity across thirty slides",
  primaryMessage: "Long decks should stay editable, non-empty, and structurally valid",
  language: "en",
  slideCountTarget: 30,
  assets: [{ id: "program-chart", kind: "chart", purpose: "Show program signal", description: "Synthetic program trend chart", required: false }],
  slides: Array.from({ length: 30 }, (_, index) => longDeckSlide(index)),
});

export const tableHeavyDeckFixture = benchmarkDeck({
  key: "table-heavy-deck",
  title: "Vendor Evaluation Table Review",
  subtitle: "A table-heavy benchmark with declared assets",
  audience: "Procurement and technical evaluation team",
  objective: "Compare vendor options with table-like evidence slides",
  primaryMessage: "Structured comparisons remain editable and pass render QA",
  language: "en",
  slideCountTarget: 5,
  assets: [
    { id: "vendor-table-a", kind: "table", purpose: "Summarize vendor capabilities", description: "Capability comparison table", required: false },
    { id: "vendor-table-b", kind: "table", purpose: "Summarize implementation risks", description: "Risk comparison table", required: false },
  ],
  slides: [
    slide("table-cover", "cover", "Vendor Evaluation Table Review", ["Capability", "Risk", "Recommendation"], coverLayout("table-cover"), {
      headline: "Compare options without flattening the decision story",
    }),
    slide("table-capabilities", "data", "Capability table favors the integrated workspace", ["Source connectors", "Editable outputs", "Self-hosted deployment"], tableInsightLayout("table-capabilities"), {
      visualIntent: "Table comparing vendor capability coverage",
      assetRefs: ["vendor-table-a"],
    }),
    slide("table-risks", "data", "Risk table highlights migration complexity", ["Data mapping", "User enablement", "Governance review"], tableInsightLayout("table-risks"), {
      visualIntent: "Table comparing migration risks by vendor",
      assetRefs: ["vendor-table-b"],
    }),
    slide("table-choice", "comparison", "The short list separates platform fit from point features", ["Feature checklist", "Workflow platform fit"], comparisonLayout("table-choice")),
    slide("table-close", "closing", "Advance two vendors to hands-on proof", ["Run source import", "Render artifacts", "Review admin controls"], closingLayout("table-close"), {
      headline: "The proof should test real workflow evidence",
    }),
  ],
});

export const multilingualDeckFixture = benchmarkDeck({
  key: "multilingual-deck",
  title: "Global Research Briefing",
  subtitle: "English and Chinese benchmark content",
  audience: "Bilingual product and research stakeholders",
  objective: "Render multilingual text as editable PPTX content",
  primaryMessage: "Multilingual decks should preserve source meaning and editable text runs",
  language: "auto",
  slideCountTarget: 4,
  slides: [
    slide("multi-cover", "cover", "Global Research Briefing", ["Evidence", "洞察", "Next steps"], coverLayout("multi-cover"), {
      headline: "Connect source evidence with bilingual synthesis",
    }),
    slide("multi-context", "content", "Regional teams need shared context", ["English notes summarize customer needs", "中文资料保留本地语境", "Shared artifacts reduce translation drift"], threeCardsLayout("multi-context")),
    slide("multi-process", "content", "A bilingual workflow keeps claims traceable", ["Collect sources", "标注关键证据", "Compare claims", "Publish briefing"], processLayout("multi-process", 4)),
    slide("multi-close", "closing", "Ship one bilingual source set first", ["Align glossary", "Review citations", "Share editable deck"], closingLayout("multi-close"), {
      headline: "本地语境 and global decisions can coexist",
    }),
  ],
});

export const conflictingStyleConstraintsFixture = benchmarkDeck({
  key: "conflicting-style-constraints",
  title: "Conflicting Style Constraints Stress Deck",
  subtitle: "Adversarial fixture for typed diagnostics",
  audience: "QA reviewers validating composer diagnostics",
  objective: "Trigger deterministic diagnostics without external services",
  primaryMessage: "Conflicting style direction plus missing required content must produce typed outcomes",
  language: "en",
  slideCountTarget: 3,
  designOverrides: {
    name: "Conflicting Pale Minimal Dense Brand",
    palette: {
      background: "#F8FAFC",
      foreground: "#E2E8F0",
      accent: "#CBD5E1",
      muted: "#E5E7EB",
      surface: "#F1F5F9",
    },
    density: "airy",
    brandNotes: "Use extremely pale minimal styling while also packing dense evidence into each slide.",
  },
  slides: [
    slide("conflict-cover", "cover", "Conflicting Style Constraints Stress Deck", ["Pale brand", "Dense story", "Missing evidence"], coverLayout("conflict-cover"), {
      headline: "This fixture should not silently pass quality gates",
    }),
    slide("conflict-table", "data", "Table evidence is requested but undeclared", ["Vendor A", "Vendor B", "Vendor C"], missingTableLayout("conflict-table"), {
      visualIntent: "A required comparison table without a declared table asset",
    }),
    slide("conflict-close", "closing", "Typed diagnostics should guide repair", ["Report the missing table slot", "Preserve contrast warnings", "Avoid weakening thresholds"], closingLayout("conflict-close"), {
      headline: "Adversarial cases must fail loudly or repair explicitly",
    }),
  ],
});

function benchmarkDeck(input: {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  readonly audience: string;
  readonly objective: string;
  readonly primaryMessage: string;
  readonly language: PresentationSourceV1["designSystem"]["language"];
  readonly slideCountTarget: number;
  readonly slides: SlideInstruction[];
  readonly assets?: PresentationSourceV1["assetPlan"]["items"];
  readonly designOverrides?: Partial<PresentationSourceV1["designSystem"]>;
}): PresentationSourceV1 {
  return {
    ...basicProductOverviewFixture,
    requirementAnalysis: {
      audience: input.audience,
      objective: input.objective,
      primaryMessage: input.primaryMessage,
      constraints: ["Native editable PPTX output", "No external services", "Deterministic benchmark content"],
      successCriteria: ["Deck renders valid PPTX", "All expected text remains editable", "No empty slides"],
      language: input.language,
    },
    contentBrief: {
      title: input.title,
      subtitle: input.subtitle,
      narrativeArc: input.slides.map((entry) => entry.title).slice(0, 12),
      keyPoints: input.slides.flatMap((entry) => entry.body).slice(0, 24),
      sourceSummary: `Deterministic benchmark fixture for ${input.key}.`,
    },
    deckStrategy: {
      deckTitle: input.title,
      audienceTakeaway: input.primaryMessage,
      storyBeats: input.slides.map((entry) => entry.role).slice(0, 16),
      slideCountTarget: input.slideCountTarget,
      pacing: input.slideCountTarget > 12 ? "direct" : "balanced",
    },
    designSystem: {
      ...basicProductOverviewFixture.designSystem,
      name: `${input.title} Design System`,
      language: input.language,
      palette,
      ...input.designOverrides,
    },
    assetPlan: {
      items: input.assets ?? [],
      notes: "Fixture assets are declared for QA slot satisfaction; no binary assets are required for rendering.",
    },
    slides: input.slides,
    qaReport: { status: "not_run", issues: [] },
    renderMetadata: {
      engine: "pptxgenjs-native",
      slideCount: input.slides.length,
      editableCompatibility: "native-v1",
      editablePrimitiveCountsBySlide: [],
      warnings: [],
    },
  } satisfies PresentationSourceV1;
}

function slide(
  id: string,
  role: SlideInstruction["role"],
  title: string,
  body: string[],
  layout: LayoutSpec,
  options: Pick<BenchmarkSlideInput, "headline" | "visualIntent" | "assetRefs"> = {},
): SlideInstruction {
  return {
    id,
    role,
    title,
    ...(options.headline ? { headline: options.headline } : {}),
    body,
    speakerNotes: `Benchmark speaker notes for ${title}.`,
    ...(options.visualIntent ? { visualIntent: options.visualIntent } : {}),
    layoutSpec: layout,
    assetRefs: options.assetRefs ?? [],
  };
}

function coverLayout(name: string): LayoutSpec {
  return {
    kind: "locked",
    name: `${name}-cover`,
    intent: "Cover slide with title, headline, and proof chips.",
    requiredSlots: ["title", "headline", "proof-chips"],
    regions: [
      region(`${name}-title`, "title", 0.08, 0.16, 0.64, 0.18),
      region(`${name}-headline`, "headline", 0.08, 0.38, 0.7, 0.18),
      region(`${name}-proof`, "proof-chips", 0.08, 0.68, 0.76, 0.14),
    ],
    balance: "left-weighted",
  };
}

function threeCardsLayout(name: string): LayoutSpec {
  return {
    kind: "parametric",
    name: `${name}-three-cards`,
    intent: "Three editable cards with a title row.",
    requiredSlots: ["title", "card-1", "card-2", "card-3"],
    regions: [
      region(`${name}-title`, "title", 0.08, 0.08, 0.84, 0.12),
      region(`${name}-card-1`, "card-1", 0.08, 0.32, 0.25, 0.34),
      region(`${name}-card-2`, "card-2", 0.38, 0.32, 0.25, 0.34),
      region(`${name}-card-3`, "card-3", 0.68, 0.32, 0.25, 0.34),
    ],
    balance: "grid",
  };
}

function processLayout(name: string, stepCount: 3 | 4 | 5): LayoutSpec {
  const gap = 0.035;
  const left = 0.08;
  const width = Number(((0.84 - gap * (stepCount - 1)) / stepCount).toFixed(4));
  return {
    kind: "parametric",
    name: `${name}-process-${stepCount}`,
    intent: "Editable process sequence.",
    requiredSlots: ["title", ...Array.from({ length: stepCount }, (_, index) => `step-${index + 1}`)],
    regions: [
      region(`${name}-title`, "title", 0.08, 0.08, 0.84, 0.12),
      ...Array.from({ length: stepCount }, (_, index) =>
        region(`${name}-step-${index + 1}`, `step-${index + 1}`, Number((left + index * (width + gap)).toFixed(4)), 0.34, width, 0.3),
      ),
    ],
    balance: "grid",
    extensions: { stepCount },
  };
}

function comparisonLayout(name: string): LayoutSpec {
  return {
    kind: "locked",
    name: `${name}-comparison`,
    intent: "Two-option comparison with title.",
    requiredSlots: ["title", "option-a", "option-b"],
    regions: [
      region(`${name}-title`, "title", 0.08, 0.08, 0.84, 0.12),
      region(`${name}-a`, "option-a", 0.08, 0.3, 0.38, 0.44),
      region(`${name}-b`, "option-b", 0.54, 0.3, 0.38, 0.44),
    ],
    balance: "grid",
  };
}

function chartInsightLayout(name: string): LayoutSpec {
  const layoutName = `metric-panel-${name.replace(/chart|insight|data|card/gi, "metric")}`;
  return {
    kind: "generated",
    name: layoutName,
    intent: "Metric panel represented as editable text regions.",
    requiredSlots: ["title", "column-a", "column-b"],
    regions: [
      region(`${name}-title`, "title", 0.08, 0.08, 0.84, 0.12),
      region(`${name}-a`, "column-a", 0.08, 0.3, 0.38, 0.44),
      region(`${name}-b`, "column-b", 0.54, 0.3, 0.38, 0.44),
    ],
    balance: "grid",
  };
}

function tableInsightLayout(name: string): LayoutSpec {
  return {
    kind: "generated",
    name: `${name}-evidence-grid`,
    intent: "Table-like evidence grid represented as editable text columns.",
    requiredSlots: ["title", "column-a", "column-b"],
    regions: [
      region(`${name}-title`, "title", 0.08, 0.08, 0.84, 0.12),
      region(`${name}-a`, "column-a", 0.08, 0.3, 0.38, 0.44),
      region(`${name}-b`, "column-b", 0.54, 0.3, 0.38, 0.44),
    ],
    balance: "grid",
  };
}

function missingTableLayout(name: string): LayoutSpec {
  return {
    kind: "generated",
    name: `${name}-table-insight`,
    intent: "Adversarial table requirement with no declared table asset.",
    requiredSlots: ["title", "table", "insight"],
    regions: [
      region(`${name}-title`, "title", 0.08, 0.08, 0.84, 0.12),
      region(`${name}-table`, "table", 0.08, 0.28, 0.54, 0.46),
      region(`${name}-insight`, "insight", 0.68, 0.32, 0.24, 0.34),
    ],
    balance: "right-weighted",
  };
}

function closingLayout(name: string): LayoutSpec {
  return {
    kind: "locked",
    name: `${name}-closing`,
    intent: "Closing recommendation with next-step checklist.",
    requiredSlots: ["title", "headline", "checklist"],
    regions: [
      region(`${name}-title`, "title", 0.1, 0.14, 0.8, 0.16),
      region(`${name}-headline`, "headline", 0.16, 0.38, 0.68, 0.16),
      region(`${name}-checklist`, "checklist", 0.22, 0.62, 0.56, 0.16),
    ],
    balance: "centered",
  };
}

function region(id: string, slot: string, x: number, y: number, width: number, height: number): LayoutSpec["regions"][number] {
  return { id, slot, x, y, width, height, zIndex: 1 };
}

function longDeckSlide(index: number): SlideInstruction {
  const slideNumber = index + 1;
  const title = `Program review milestone ${slideNumber}`;
  const cycle = index % 5;
  if (index === 0) {
    return slide("long-01", "cover", "Thirty Slide Program Review", ["Scope", "Status", "Decisions"], coverLayout("long-01"), {
      headline: "A long deck can remain structurally editable",
    });
  }
  if (cycle === 1) {
    return slide(`long-${String(slideNumber).padStart(2, "0")}`, "content", title, [`Milestone ${slideNumber} objective`, "Owner alignment", "Evidence checkpoint"], threeCardsLayout(`long-${slideNumber}`));
  }
  if (cycle === 2) {
    return slide(`long-${String(slideNumber).padStart(2, "0")}`, "content", title, ["Prepare", "Review", "Decide", "Record"], processLayout(`long-${slideNumber}`, 4));
  }
  if (cycle === 3) {
    return slide(`long-${String(slideNumber).padStart(2, "0")}`, "comparison", title, ["Current operating mode", "Target operating mode"], comparisonLayout(`long-${slideNumber}`));
  }
  if (cycle === 4) {
    return slide(`long-${String(slideNumber).padStart(2, "0")}`, "data", title, ["Quality", "Velocity", "Reuse"], chartInsightLayout(`long-${slideNumber}`), {
      visualIntent: `Program signal chart for milestone ${slideNumber}`,
      assetRefs: ["program-chart"],
    });
  }
  return slide(`long-${String(slideNumber).padStart(2, "0")}`, "closing", title, ["Confirm owner", "Capture decision", "Update source set"], closingLayout(`long-${slideNumber}`), {
    headline: `Close milestone ${slideNumber} with a documented next step`,
  });
}
