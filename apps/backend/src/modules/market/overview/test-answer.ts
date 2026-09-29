import { buildMcpOverviewInput } from "./input";
import { buildMcpOverviewPrompt } from "./prompt";
import { genesis402Source } from "./test-fixtures";

/**
 * The ID of the one passage of the genesis402 fixture's prompt whose text
 * contains `fragment`, and that passage's text as the parser stores it
 * (whitespace collapsed). Its README passages are the same however the
 * version was stored, since they come from the README alone.
 */
export function genesis402Passage(fragment: string): {
  id: string;
  stored: string;
} {
  const prompt = buildMcpOverviewPrompt(
    buildMcpOverviewInput(genesis402Source()),
  );
  const found = prompt.passages.filter((passage) =>
    passage.text.includes(fragment),
  );
  if (found.length !== 1) {
    throw new Error(
      `${found.length} genesis402 passages contain ${JSON.stringify(fragment)}`,
    );
  }
  return {
    id: found[0]!.id,
    stored: found[0]!.text.replace(/\s+/g, " ").trim(),
  };
}

// The README passages the answer below cites.
export const genesis402Evidence = {
  finance: genesis402Passage("DeFi yields from 15,000+ pools"),
  webExtraction: genesis402Passage("Any public web page as clean text"),
};

/**
 * A structured answer the system model could give for the genesis402 fixture
 * (`test-fixtures.ts`): three locales, and a primary and one secondary
 * category whose evidence cites README passages by ID. For tests that stand
 * in for the model call.
 */
export function genesis402ModelAnswer(
  options: { summaryPrefix?: string } = {},
) {
  const prefix = options.summaryPrefix ?? "";
  return {
    en: {
      summary: `${prefix}Lets an assistant call pay-per-call APIs for market, wallet and web data, paid in USDC per call.`,
      whatItDoes:
        "Exposes tools for DeFi yields, SEC financials, wallet and token risk signals and web extraction. Each paid call returns a price quote first and pays only in live mode.",
      whenToUse:
        "Use it when an agent needs occasional paid data lookups without an account or subscription.",
      requirements:
        "Node.js to run the genesis402-mcp npm package locally. Paying needs GENESIS402_LIVE=1 and a wallet private key in GENESIS402_PAYER_KEY.",
      cautions:
        "GENESIS402_PAYER_KEY is a wallet private key and live mode spends USDC. Use a dedicated wallet with a small balance and a low GENESIS402_MAX_USD cap.",
    },
    "zh-CN": {
      summary: `${prefix}让助手按次付费调用市场、钱包和网页数据 API，以 USDC 结算。`,
      whatItDoes:
        "提供 DeFi 收益、SEC 财务数据、钱包与代币风险信号和网页提取等工具。",
      whenToUse: "适合偶尔需要付费数据查询、又不想注册账户的智能体。",
      requirements:
        "需要 Node.js 在本地运行 npm 包；付费需设置 GENESIS402_PAYER_KEY。",
      cautions: "GENESIS402_PAYER_KEY 是钱包私钥，实时模式会花费 USDC。",
    },
    "zh-TW": {
      summary: `${prefix}讓助理按次付費呼叫市場、錢包和網頁資料 API，以 USDC 結算。`,
      whatItDoes:
        "提供 DeFi 收益、SEC 財務資料、錢包與代幣風險訊號和網頁擷取等工具。",
      whenToUse: "適合偶爾需要付費資料查詢、又不想註冊帳號的代理程式。",
      requirements:
        "需要 Node.js 在本機執行 npm 套件；付費需設定 GENESIS402_PAYER_KEY。",
      cautions: "",
    },
    classification: {
      primary: { slug: "finance", evidence: genesis402Evidence.finance.id },
      secondary: [
        {
          slug: "web-search-scraping",
          evidence: genesis402Evidence.webExtraction.id,
        },
      ],
      rationale:
        "Paid financial and market data is the main purpose; web extraction is a second one.",
    },
  };
}
