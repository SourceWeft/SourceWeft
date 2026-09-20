import en from "../messages/en.json";
import zhCN from "../messages/zh-CN.json";
import zhTW from "../messages/zh-TW.json";

// Localized *display* copy for the pricing cards. This is the commercial-license
// side of the pricing split: the canonical English + structural data stays in
// `./catalog` (PlanConfig, used by product creation and analytics); this is only
// what the marketing UI shows. The web app merges it under the `pricing`
// namespace of its i18n catalog (design D8 / §20).
export const billingMessages = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
} as const;

export type BillingMessageLocale = keyof typeof billingMessages;

export function getBillingMessages(locale: string) {
  return (
    billingMessages[locale as BillingMessageLocale] ?? billingMessages.en
  );
}
