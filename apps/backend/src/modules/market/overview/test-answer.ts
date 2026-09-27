/**
 * A structured answer the system model could give for the genesis402 fixture
 * (`test-fixtures.ts`): three locales and two categories whose evidence is
 * quoted from its README. For tests that stand in for the model call.
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
      categories: [
        { slug: "finance", evidence: "DeFi yields from 15,000+ pools" },
        {
          slug: "web-search-scraping",
          evidence:
            "Any public web page as clean text, title, headings and links.",
        },
      ],
      rationale:
        "Paid financial and market data is the main purpose; web extraction is a second one.",
    },
  };
}
