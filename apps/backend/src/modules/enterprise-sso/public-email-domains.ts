/**
 * Shared consumer email domains that no single tenant may claim as its SSO
 * domain.
 *
 * Account linking trusts "a verified SSO domain whose email domain matches".
 * If a team could register a public mailbox provider's domain (e.g.
 * `gmail.com`), verifying it would let that team's IdP vouch for every account
 * whose email ends in that domain — an account-takeover vector. These domains
 * are therefore rejected at registration regardless of verification.
 *
 * The list is intentionally conservative (well-known global and Chinese
 * consumer providers); it does not try to be exhaustive. Entries are the bare
 * registrable domains, lowercase.
 */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "gmx.com",
  "mail.com",
  "yandex.com",
  "zoho.com",
  "qq.com",
  "foxmail.com",
  "163.com",
  "126.com",
  "yeah.net",
  "sina.com",
  "sina.cn",
  "sohu.com",
  "139.com",
  "189.cn",
  "aliyun.com",
]);
