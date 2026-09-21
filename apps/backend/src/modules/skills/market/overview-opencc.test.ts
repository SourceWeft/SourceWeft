import assert from "node:assert/strict";
import { test } from "vitest";
import { convertOverviewToZhTw, toTaiwanTraditional } from "./overview-opencc";

test("zh-CN becomes Traditional Chinese with Taiwan phrasing", () => {
  assert.equal(
    toTaiwanTraditional("这个技能用于生成软件和演示文稿，需要安装依赖。"),
    "這個技能用於生成軟體和簡報，需要安裝依賴。",
  );
  // Text with nothing to convert passes through.
  assert.equal(toTaiwanTraditional("Python 3, openpyxl"), "Python 3, openpyxl");
});

test("every text field of an overview is converted; category slugs are not", () => {
  const converted = convertOverviewToZhTw({
    summary: "把表格变成图表。",
    whatItDoes: "读取文件并绘制图表。",
    whenToUse: "需要快速图表时。",
    requirements: "需要网络连接。",
    suggestedCategories: ["data-analysis"],
  });
  assert.deepEqual(converted, {
    summary: "把表格變成圖表。",
    whatItDoes: "讀取檔案並繪製圖表。",
    whenToUse: "需要快速圖表時。",
    requirements: "需要網路連線。",
    suggestedCategories: ["data-analysis"],
  });
});

test("OpenCC's word-splitting slips and the site's own terms are corrected", () => {
  assert.equal(
    toTaiwanTraditional(
      "无需脚本或资源文件，基于开源文件；需要 API 令牌和凭据。",
    ),
    "無需指令碼或資源檔案，基於開源檔案；需要 API 權杖和憑證。",
  );
});
