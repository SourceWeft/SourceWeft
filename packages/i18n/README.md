# @sourceweft/i18n

Framework-agnostic locale primitives shared by the web app (routing, formatting),
the backend (mail locale resolution), and any future client. It holds **no copy** —
message catalogs live with their owners (`apps/web/messages`, `enterprise/billing/messages`)
per design decision D8/D9.

See `docs/architecture/i18n-multilanguage.md` for the full design.

## Modules

- `./locales` — `LOCALES` / `LOCALE_IDS` / `DEFAULT_LOCALE` / `LocaleMeta`. The single
  source of truth for supported languages. Adding one is a one-row change (D2).
- `./resolve` — locale negotiation and URL-prefix helpers used by the Next proxy and
  the language switcher: `normalizeToLocale`, `parseAcceptLanguage`, `negotiateLocale`,
  `stripLocalePrefix`, `addLocalePrefix`.
- `./format` — the only sanctioned place to construct `Intl.*`: `formatDate`,
  `formatNumber`, `formatCurrency` (USD by default, D10), `formatRelativeTime`.
- `./catalog` — the message-catalog contract: `deepMergeMessages` (fold the pricing
  namespace across the license boundary), `getFallbackChain`, `flattenKeys`.

## Test

```bash
pnpm --filter @sourceweft/i18n test
```
