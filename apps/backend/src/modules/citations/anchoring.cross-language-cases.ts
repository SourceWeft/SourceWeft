/**
 * Cross-language cases for citation anchoring (#516): a claim in one language
 * and a cited chunk in the other. Shared by the offline evaluation test (word
 * matching only) and `scripts/eval-citation-anchoring.ts` (the by-meaning pass
 * against the real embedding model).
 *
 * `expect` is a fragment the located passage must contain, or null when
 * nothing in the chunk supports the claim.
 */

export type CrossLanguageCategory =
  | "zh-over-en"
  | "en-over-zh"
  | "table-and-mixed"
  | "absent-figure"
  | "absent-topic"
  /** Same figures, opposite direction: not detectable by meaning plus figures; reported only. */
  | "contradiction";

export type CrossLanguageCase = {
  category: CrossLanguageCategory;
  claim: string;
  content: string;
  expect: string | null;
};

const EN_A =
  "Net sales rose 14% to $7.8 billion in the second quarter. The company employs 3,400 people across 18 countries. Battery capacity increased from 60 kWh to 82 kWh. The clinical trial enrolled 1,200 patients over 24 months.";
const EN_B =
  "Annual rainfall in the region averages 640 millimetres. The new bridge is 2.4 kilometres long and opened in 2023. Participants must be at least 18 years old and complete three training modules. Subscription prices start at $12 per month for the basic plan.";
const EN_C =
  "The study found that 68% of respondents preferred remote work. The satellite was launched in March and operates at 550 kilometres altitude. Warranty coverage lasts five years or 100,000 kilometres. The conference will host 40 speakers and 5,000 attendees.";
const ZH_A =
  "第二季度净销售额增长14%，达到78亿美元。公司在18个国家共有3400名员工。电池容量从60千瓦时提高到82千瓦时。这项临床试验在24个月内招募了1200名患者。";
const ZH_B =
  "该地区年均降雨量为640毫米。新大桥全长2.4公里，于2023年通车。参与者必须年满18岁并完成三个培训模块。基础套餐的订阅价格从每月12美元起。";
const ZH_C =
  "研究发现68%的受访者更喜欢远程办公。该卫星于3月发射，运行在550公里高度。质保期为五年或10万公里。大会将邀请40位演讲者和5000名参会者。";

const TABLE_EN =
  "| Plan | Seats | Price |\n| --- | --- | --- |\n| Starter | 5 | $9 |\n| Team | 25 | $49 |\n| Business | 100 | $199 |\n";
const TABLE_ZH =
  "| 套餐 | 席位 | 价格 |\n| --- | --- | --- |\n| 入门版 | 5 | 9美元 |\n| 团队版 | 25 | 49美元 |\n| 商业版 | 100 | 199美元 |\n";
const MIXED_EN =
  "The report quotes the founder: “我们将继续投资云计算。” Revenue grew 23% to $4.1 billion in fiscal 2025, driven by cloud services.";
const MIXED_ZH =
  "报告引用了创始人的话：“We will keep investing in cloud computing.”2025财年营收增长23%，达到41亿美元，主要由云服务驱动。";

const c = (
  category: CrossLanguageCategory,
  claim: string,
  content: string,
  expect: string | null,
): CrossLanguageCase => ({ category, claim, content, expect });

export const CROSS_LANGUAGE_CASES: CrossLanguageCase[] = [
  c(
    "zh-over-en",
    "第二季度净销售额同比增长14%，达到78亿美元",
    EN_A,
    "Net sales rose 14%",
  ),
  c("zh-over-en", "公司的员工遍布18个国家，共3400人", EN_A, "employs 3,400"),
  c("zh-over-en", "电池容量由60千瓦时提升至82千瓦时", EN_A, "Battery capacity"),
  c(
    "zh-over-en",
    "这项临床试验用24个月招募了1200名患者",
    EN_A,
    "clinical trial",
  ),
  c("zh-over-en", "该地区年平均降雨量约640毫米", EN_B, "rainfall"),
  c("zh-over-en", "新桥长2.4公里，2023年开通", EN_B, "new bridge"),
  c("zh-over-en", "参与者须年满18岁，并完成三个培训模块", EN_B, "Participants"),
  c("zh-over-en", "基础版订阅每月12美元起", EN_B, "Subscription prices"),
  c("zh-over-en", "调查显示68%的受访者偏好远程办公", EN_C, "68%"),
  c("zh-over-en", "卫星3月发射，轨道高度550公里", EN_C, "satellite"),
  c("zh-over-en", "质保为五年或十万公里", EN_C, "Warranty"),
  c("zh-over-en", "会议将有40位演讲嘉宾和5000名与会者", EN_C, "conference"),

  c(
    "en-over-zh",
    "Net sales grew 14% year on year to $7.8 billion in the second quarter",
    ZH_A,
    "净销售额增长14%",
  ),
  c(
    "en-over-zh",
    "The company has 3,400 employees in 18 countries",
    ZH_A,
    "3400名员工",
  ),
  c(
    "en-over-zh",
    "Battery capacity went from 60 kWh to 82 kWh",
    ZH_A,
    "电池容量",
  ),
  c(
    "en-over-zh",
    "The trial enrolled 1,200 patients in 24 months",
    ZH_A,
    "临床试验",
  ),
  c("en-over-zh", "Average annual rainfall is about 640 mm", ZH_B, "降雨量"),
  c("en-over-zh", "The 2.4 km bridge opened in 2023", ZH_B, "新大桥"),
  c(
    "en-over-zh",
    "Participants need to be 18 or older and finish three training modules",
    ZH_B,
    "参与者",
  ),
  c("en-over-zh", "The basic plan starts at $12 a month", ZH_B, "基础套餐"),
  c(
    "en-over-zh",
    "68% of respondents said they prefer remote work",
    ZH_C,
    "68%",
  ),
  c(
    "en-over-zh",
    "The satellite launched in March and orbits at 550 km",
    ZH_C,
    "卫星",
  ),
  c("en-over-zh", "The warranty is five years or 100,000 km", ZH_C, "质保期"),
  c(
    "en-over-zh",
    "The conference expects 40 speakers and 5,000 attendees",
    ZH_C,
    "大会",
  ),

  c("table-and-mixed", "团队版包含25个席位，售价49美元", TABLE_EN, "Team"),
  c(
    "table-and-mixed",
    "商业版有100个席位，价格为199美元",
    TABLE_EN,
    "Business",
  ),
  c(
    "table-and-mixed",
    "The Team plan has 25 seats and costs $49",
    TABLE_ZH,
    "团队版",
  ),
  c(
    "table-and-mixed",
    "The Business plan includes 100 seats at $199",
    TABLE_ZH,
    "商业版",
  ),
  c(
    "table-and-mixed",
    "2025财年营收增长23%，达到41亿美元",
    MIXED_EN,
    "Revenue grew 23%",
  ),
  c(
    "table-and-mixed",
    "Revenue grew 23% to $4.1 billion in fiscal 2025",
    MIXED_ZH,
    "2025财年营收增长23%",
  ),

  c("absent-figure", "第二季度净销售额增长41%，达到78亿美元", EN_A, null),
  c("absent-figure", "公司在81个国家共有3400名员工", EN_A, null),
  c("absent-figure", "电池容量由60千瓦时提升至95千瓦时", EN_A, null),
  c("absent-figure", "试验在36个月内招募了1200名患者", EN_A, null),
  c("absent-figure", "该地区年均降雨量为940毫米", EN_B, null),
  c("absent-figure", "新桥全长3.4公里，2021年通车", EN_B, null),
  c(
    "absent-figure",
    "Participants must be at least 21 years old and complete five training modules",
    ZH_B,
    null,
  ),
  c("absent-figure", "The basic plan starts at $19 per month", ZH_B, null),
  c(
    "absent-figure",
    "72% of respondents said they prefer remote work",
    ZH_C,
    null,
  ),
  c(
    "absent-figure",
    "The satellite launched in May and orbits at 800 km",
    ZH_C,
    null,
  ),
  c("absent-figure", "The warranty is eight years or 160,000 km", ZH_C, null),
  c(
    "absent-figure",
    "The conference expects 90 speakers and 12,000 attendees",
    ZH_C,
    null,
  ),

  c("absent-topic", "公司计划明年在新加坡设立研发中心", EN_A, null),
  c("absent-topic", "该公司获得了政府的税收补贴", EN_A, null),
  c("absent-topic", "地震后该地区重建了学校", EN_B, null),
  c("absent-topic", "订阅用户可以免费下载离线内容", EN_B, null),
  c("absent-topic", "大多数受访者居住在城市", EN_C, null),
  c("absent-topic", "发射任务由一家私营公司承包", EN_C, null),
  c(
    "absent-topic",
    "The company plans to open a research center in Singapore next year",
    ZH_A,
    null,
  ),
  c("absent-topic", "The firm received government tax subsidies", ZH_A, null),
  c(
    "absent-topic",
    "Schools were rebuilt in the region after the earthquake",
    ZH_B,
    null,
  ),
  c(
    "absent-topic",
    "Subscribers can download content for offline use for free",
    ZH_B,
    null,
  ),
  c("absent-topic", "Most respondents live in cities", ZH_C, null),
  c(
    "absent-topic",
    "The launch was contracted to a private company",
    ZH_C,
    null,
  ),

  c("contradiction", "第二季度净销售额下降14%，降至78亿美元", EN_A, null),
  c("contradiction", "电池容量从82千瓦时降至60千瓦时", EN_A, null),
  c(
    "contradiction",
    "Net sales fell 14% to $7.8 billion in the second quarter",
    ZH_A,
    null,
  ),
  c(
    "contradiction",
    "Battery capacity dropped from 82 kWh to 60 kWh",
    ZH_A,
    null,
  ),
];

export const SUPPORTED_CATEGORIES: readonly CrossLanguageCategory[] = [
  "zh-over-en",
  "en-over-zh",
  "table-and-mixed",
];
export const UNSUPPORTED_CATEGORIES: readonly CrossLanguageCategory[] = [
  "absent-figure",
  "absent-topic",
];
