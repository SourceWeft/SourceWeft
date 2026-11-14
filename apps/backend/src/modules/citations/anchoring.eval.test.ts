import assert from "node:assert/strict";
import { test } from "vitest";
import { anchorClaimInContent } from "./anchoring";

/**
 * Offline evaluation set for Issue #472. Each case is a claim an answer made
 * and the chunk it cited; `expect` is a fragment the located passage must
 * contain, or null when nothing in the chunk supports the claim.
 *
 * The categories are reported separately. The set is small and hand-written,
 * so its rates are a regression guard, not a population estimate. `cross-language` cases are real
 * supported claims the lexical matcher cannot see (a Chinese answer citing an
 * English chunk); they document the known gap and are not part of the recall
 * gate.
 */

type Category =
  | "verbatim"
  | "paraphrase"
  | "chinese"
  | "markup"
  | "unsupported"
  | "cross-language";

type Case = {
  category: Category;
  claim: string;
  content: string;
  expect: string | null;
};

const REPORT =
  "Overview of the company. Revenue grew 23% to $4.1 billion in fiscal 2025, driven by cloud services. " +
  "Headcount stayed flat at 12,000 employees. The board approved a new buyback programme worth $500 million. " +
  "Operating margin improved to 18.5% from 16.2% a year earlier.";

const CLIMATE =
  "Global mean temperature in 2023 was 1.45 degrees Celsius above the pre-industrial baseline. " +
  "Sea level rose by 4.8 millimetres per year over the last decade. " +
  "Arctic sea ice extent reached its fourth lowest September minimum on record. " +
  "Renewable sources supplied 30% of global electricity generation.";

const POLICY =
  "Employees may carry over up to five unused vacation days into the next calendar year. " +
  "Requests longer than ten consecutive working days require written approval from a director. " +
  "Remote work is permitted for up to three days per week with manager consent. " +
  "Expense reports must be submitted within 30 days of purchase.";

const ZH_REPORT =
  "公司概况。2025财年营收增长23%，达到41亿美元，主要由云服务驱动。员工人数保持在12000人。" +
  "董事会批准了一项价值5亿美元的新回购计划。营业利润率从16.2%提升至18.5%。";

const ZH_HEALTH =
  "成年人每周应至少进行150分钟中等强度的有氧运动。每天久坐超过八小时会显著增加心血管疾病风险。" +
  "地中海饮食有助于降低胆固醇水平。成年人每晚建议睡眠七到九小时。";

const TABLE_MD =
  "| Region | Revenue | Growth |\n| --- | --- | --- |\n| North America | $2.4 billion | 19% |\n" +
  "| Europe | $1.1 billion | 27% |\n| Asia Pacific | $0.6 billion | 41% |\n";

const TABLE_HTML =
  "<table><thead><tr><th>Plan</th><th>Seats</th><th>Price</th></tr></thead><tbody>" +
  "<tr><td>Starter</td><td>5</td><td>$9</td></tr>" +
  "<tr><td>Team</td><td>25</td><td>$49</td></tr>" +
  "<tr><td>Business</td><td>100</td><td>$199</td></tr></tbody></table>\n\n" +
  "All plans include single sign-on and audit logs.";

const CASES: Case[] = [
  // verbatim-ish English
  {
    category: "verbatim",
    claim: "Revenue grew 23% to $4.1 billion in fiscal 2025",
    content: REPORT,
    expect: "Revenue grew 23%",
  },
  {
    category: "verbatim",
    claim: "Headcount stayed flat at 12,000 employees",
    content: REPORT,
    expect: "Headcount stayed flat",
  },
  {
    category: "verbatim",
    claim: "The board approved a new buyback programme worth $500 million",
    content: REPORT,
    expect: "buyback programme",
  },
  {
    category: "verbatim",
    claim: "Operating margin improved to 18.5% from 16.2%",
    content: REPORT,
    expect: "Operating margin",
  },
  {
    category: "verbatim",
    claim: "Sea level rose by 4.8 millimetres per year over the last decade",
    content: CLIMATE,
    expect: "Sea level rose",
  },
  {
    category: "verbatim",
    claim:
      "Arctic sea ice reached its fourth lowest September minimum on record",
    content: CLIMATE,
    expect: "Arctic sea ice",
  },
  {
    category: "verbatim",
    claim: "Remote work is permitted for up to three days per week",
    content: POLICY,
    expect: "Remote work",
  },
  {
    category: "verbatim",
    claim: "Expense reports must be submitted within 30 days of purchase",
    content: POLICY,
    expect: "Expense reports",
  },

  // paraphrase English (shared numbers and key terms, different wording)
  {
    category: "paraphrase",
    claim: "Sales rose 23 percent, reaching $4.1 billion, thanks to cloud",
    content: REPORT,
    expect: "Revenue grew 23%",
  },
  {
    category: "paraphrase",
    claim: "The company's operating margin went up to 18.5%",
    content: REPORT,
    expect: "Operating margin",
  },
  {
    category: "paraphrase",
    claim:
      "Temperatures in 2023 were 1.45 degrees Celsius over pre-industrial levels",
    content: CLIMATE,
    expect: "1.45 degrees",
  },
  {
    category: "paraphrase",
    claim: "Renewables produced 30% of the world's electricity",
    content: CLIMATE,
    expect: "Renewable sources",
  },
  {
    category: "paraphrase",
    claim: "Staff can bring over five unused vacation days to next year",
    content: POLICY,
    expect: "carry over",
  },
  {
    category: "paraphrase",
    claim: "A director must sign off on leave longer than ten working days",
    content: POLICY,
    expect: "written approval",
  },

  // Chinese
  {
    category: "chinese",
    claim: "2025财年营收增长23%，达到41亿美元",
    content: ZH_REPORT,
    expect: "营收增长23%",
  },
  {
    category: "chinese",
    claim: "员工人数保持在12000人",
    content: ZH_REPORT,
    expect: "员工人数",
  },
  {
    category: "chinese",
    claim: "营业利润率提升至18.5%",
    content: ZH_REPORT,
    expect: "营业利润率",
  },
  {
    category: "chinese",
    claim: "成年人每周应至少进行150分钟中等强度的有氧运动",
    content: ZH_HEALTH,
    expect: "150分钟",
  },
  {
    category: "chinese",
    claim: "地中海饮食有助于降低胆固醇",
    content: ZH_HEALTH,
    expect: "地中海饮食",
  },
  {
    category: "chinese",
    claim: "成年人每晚建议睡眠七到九小时",
    content: ZH_HEALTH,
    expect: "睡眠七到九小时",
  },

  // markup: markdown table rows and HTML
  {
    category: "markup",
    claim: "Europe revenue was $1.1 billion, up 27%",
    content: TABLE_MD,
    expect: "Europe",
  },
  {
    category: "markup",
    claim: "Asia Pacific grew 41%",
    content: TABLE_MD,
    expect: "Asia Pacific",
  },
  {
    category: "markup",
    claim: "The Team plan costs $49 for 25 seats",
    content: TABLE_HTML,
    expect: "Team",
  },
  {
    category: "markup",
    claim: "The Business plan has 100 seats at $199",
    content: TABLE_HTML,
    expect: "Business",
  },
  {
    category: "markup",
    claim: "All plans include single sign-on and audit logs",
    content: TABLE_HTML,
    expect: "single sign-on",
  },

  // unsupported: nothing in the chunk backs the claim (some share a few words)
  {
    category: "unsupported",
    claim: "The company opened a new office in Singapore",
    content: REPORT,
    expect: null,
  },
  {
    category: "unsupported",
    claim: "Headcount doubled to 24,000 employees after the merger",
    content: REPORT,
    expect: null,
  },
  {
    category: "unsupported",
    claim: "Sea level fell by 2 millimetres per year",
    content: CLIMATE,
    expect: null,
  },
  {
    category: "unsupported",
    claim: "Employees must work from the office five days per week",
    content: POLICY,
    expect: null,
  },
  {
    category: "unsupported",
    claim: "公司计划在2026年收购一家欧洲竞争对手",
    content: ZH_REPORT,
    expect: null,
  },
  {
    category: "unsupported",
    claim: "成年人每天应饮用三升水",
    content: ZH_HEALTH,
    expect: null,
  },
  {
    category: "unsupported",
    claim: "The Enterprise plan includes unlimited seats for $999",
    content: TABLE_HTML,
    expect: null,
  },

  // cross-language: supported, but not visible to lexical matching
  {
    category: "cross-language",
    claim: "2025财年营收增长23%，达到41亿美元",
    content: REPORT,
    expect: "Revenue grew 23%",
  },
  {
    category: "cross-language",
    claim: "海平面每年上升4.8毫米",
    content: CLIMATE,
    expect: "Sea level rose",
  },
  {
    category: "cross-language",
    claim: "每周最多可以远程办公三天",
    content: POLICY,
    expect: "Remote work",
  },
];

function evaluate(testCase: Case) {
  const anchor = anchorClaimInContent({
    claim: testCase.claim,
    content: testCase.content,
  });
  const strong = anchor?.support === "strong";
  const quote =
    strong && anchor.startChar !== null
      ? testCase.content.slice(anchor.startChar, anchor.endChar!)
      : null;
  const hit =
    testCase.expect === null
      ? !strong
      : strong && quote !== null && quote.includes(testCase.expect);
  return { strong, quote, hit, score: anchor?.score ?? 0 };
}

test("the evaluation set has at least 30 mixed cases", () => {
  assert.ok(CASES.length >= 30);
  const categories = new Set(CASES.map((item) => item.category));
  assert.equal(categories.size, 6);
});

test("anchoring meets its recorded baseline on the evaluation set", () => {
  const byCategory = new Map<Category, { hits: number; total: number }>();
  const misses: string[] = [];
  for (const testCase of CASES) {
    const result = evaluate(testCase);
    const entry = byCategory.get(testCase.category) ?? { hits: 0, total: 0 };
    entry.total += 1;
    if (result.hit) entry.hits += 1;
    else
      misses.push(
        `[${testCase.category}] ${testCase.claim} -> ${result.strong ? `strong "${result.quote}"` : "weak"} (${result.score.toFixed(2)})`,
      );
    byCategory.set(testCase.category, entry);
  }

  const summary = [...byCategory].map(
    ([category, { hits, total }]) => `${category} ${hits}/${total}`,
  );
  console.info(`citation anchoring eval: ${summary.join(", ")}`);
  for (const miss of misses) console.info(`  miss ${miss}`);

  const rate = (category: Category) => {
    const entry = byCategory.get(category)!;
    return entry.hits / entry.total;
  };
  // Supported claims in the same language as the chunk.
  const supported = (["verbatim", "paraphrase", "chinese", "markup"] as const)
    .map((category) => byCategory.get(category)!)
    .reduce(
      (sum, entry) => ({
        hits: sum.hits + entry.hits,
        total: sum.total + entry.total,
      }),
      { hits: 0, total: 0 },
    );
  assert.ok(
    supported.hits / supported.total >= BASELINE.supportedRecall,
    `supported recall ${supported.hits}/${supported.total}`,
  );
  assert.ok(
    rate("unsupported") >= BASELINE.unsupportedRejection,
    `unsupported rejection ${rate("unsupported")}`,
  );
});

/**
 * Baseline recorded 2026-11-14 on this set (36 cases, written by hand):
 *   verbatim 8/8, paraphrase 6/6, chinese 6/6, markup 5/5 -> supported recall 25/25
 *   unsupported 6/7 rejected; cross-language 0/3 (known gap, reported only)
 * The remaining false support ("five days per week" matching "five unused
 * vacation days") scores exactly 0.50, the same as a genuine paraphrase hit,
 * so no threshold separates them. The gates sit just under the measured values
 * so a regression fails; raise them when the matcher improves.
 */
const BASELINE = { supportedRecall: 0.95, unsupportedRejection: 0.85 };
