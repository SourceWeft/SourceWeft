/**
 * OpenRouter attribution identity, kept in one place so the runtime headers and
 * the catalog-discovery client cannot advertise different applications.
 *
 * Note: `apps/backend/config/model-gateway.global.json` and
 * `model-gateway.saas.json` repeat these values in their `defaultHeaders`
 * blocks. Those are data files loaded at runtime and cannot import from here —
 * update them alongside any change made in this file.
 */
export const OPENROUTER_APP_TITLE = "SourceWeft";
