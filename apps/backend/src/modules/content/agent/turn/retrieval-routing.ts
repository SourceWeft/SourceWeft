const SOURCE_WIDE_PATTERNS = [
  /\b(summarize|summary|review|compare|analy[sz]e|list|outline|extract all|all key points)\b/i,
  /总结|概括|综述|审查|分析全文|对比|比较|列出全部|所有|全文|通读/,
];

const EXPLICIT_LEXICAL_PATTERNS = [
  /\b(grep|regex|regular expression|exact string|find occurrences|where .* appear|search for|match)\b/i,
  /正则|精确匹配|出现在哪|出现位置|搜索.*出现|查找.*出现|匹配/,
];

const TARGETED_QUESTION_PATTERNS = [
  /[?？]\s*$/,
  /\b(what|which|who|when|where|how much|how many|what is|which is|who is|when is)\b/i,
  /是什么|是多少|有哪些|哪个|哪一个|是谁|什么时候|何时|到期|价格|金额|发票号|订单号|域名|注册.*域名|供应商|客户|期限/,
];

export function shouldPreRetrieveForTurn(input: {
  messageContent: string;
  sourceIds: string[];
}) {
  const message = input.messageContent.trim();
  if (message.length === 0 || input.sourceIds.length === 0) {
    return false;
  }

  if (SOURCE_WIDE_PATTERNS.some((pattern) => pattern.test(message))) {
    return false;
  }

  if (EXPLICIT_LEXICAL_PATTERNS.some((pattern) => pattern.test(message))) {
    return false;
  }

  return TARGETED_QUESTION_PATTERNS.some((pattern) => pattern.test(message));
}
