/**
 * The i18n fallback chain for the shared selection UI, written once (R6).
 * Generic strings live under `connectors.selection.*` and take a `{provider}`
 * argument; per-connector overrides live under
 * `connectors.selection.byType.<type>.*`. `t.has` decides whether an override
 * exists, so the browser, the settings list and the settings dialog resolve
 * copy the same way without three copies of this logic.
 */

import type { useTranslations } from "next-intl";

type Translate = ReturnType<typeof useTranslations>;
type Values = Record<string, string | number>;

const ROOT = "connectors.selection";

/** A per-connector string with a generic default fallback:
 * `byType.<type>.<suffix>` when present, else `default.<suffix>`. Used for
 * `itemsTitle`, `itemsDescription`, `choose`, `empty` and
 * `browser.description`. */
export function byTypeOrDefault(
  t: Translate,
  connectorType: string,
  suffix: string,
  values?: Values,
): string {
  const key = `${ROOT}.byType.${connectorType}.${suffix}`;
  return t(t.has(key) ? key : `${ROOT}.default.${suffix}`, values);
}

/** The group heading for a kind: `byType.<type>.kinds.<kind>` when present,
 * else the kind id itself (R6). */
export function kindHeading(
  t: Translate,
  connectorType: string,
  kind: string,
): string {
  const key = `${ROOT}.byType.${connectorType}.kinds.${kind}`;
  return t.has(key) ? t(key) : kind;
}

/** The reason a non-selectable entry shows: `byType.<type>.disabledReason.
 * <code>` when present, else the generic `disabledReason.unknown`. */
export function disabledReasonText(
  t: Translate,
  connectorType: string,
  code: string,
): string {
  const key = `${ROOT}.byType.${connectorType}.disabledReason.${code}`;
  return t.has(key) ? t(key) : t(`${ROOT}.disabledReason.unknown`);
}

/** The optional note under the picker footer: `byType.<type>.browser.note`,
 * or null when the type defines none (R6). */
export function browserNote(
  t: Translate,
  connectorType: string,
): string | null {
  const key = `${ROOT}.byType.${connectorType}.browser.note`;
  return t.has(key) ? t(key) : null;
}

/** The root breadcrumb label: `byType.<type>.browser.root` when present, else
 * the connector's display name. */
export function rootLabel(
  t: Translate,
  connectorType: string,
  providerName: string,
): string {
  const key = `${ROOT}.byType.${connectorType}.browser.root`;
  return t.has(key) ? t(key) : providerName;
}

/** The text for an empty root listing: `byType.<type>.browser.emptyRoot` when
 * the type defines one, else the generic `browser.emptyContainer` (R6). */
export function emptyRootText(t: Translate, connectorType: string): string {
  const key = `${ROOT}.byType.${connectorType}.browser.emptyRoot`;
  return t.has(key) ? t(key) : t(`${ROOT}.browser.emptyContainer`);
}

/** The text for an opened container (not the root, not a search) with no
 * entries: `byType.<type>.browser.emptyContainer` when the type defines one,
 * else the generic `browser.emptyContainer`. */
export function emptyContainerText(t: Translate, connectorType: string): string {
  const key = `${ROOT}.byType.${connectorType}.browser.emptyContainer`;
  return t.has(key) ? t(key) : t(`${ROOT}.browser.emptyContainer`);
}

/** The help-link button label, or null when the type declares no label for
 * this code; the button is rendered only when this is non-null. */
export function helpLinkLabel(
  t: Translate,
  connectorType: string,
  code: string,
): string | null {
  const key = `${ROOT}.byType.${connectorType}.helpLink.${code}`;
  return t.has(key) ? t(key) : null;
}

/** A display name that shows `connectors.selection.untitled` for an empty
 * name, and `fallbackId` for a name that is absent (null/undefined). Entries
 * always carry a string name; describe items may carry null. The accessible
 * `{name}` labels interpolate the same result. */
export function displayName(
  t: Translate,
  name: string | null | undefined,
  fallbackId: string,
): string {
  if (name == null) return fallbackId;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : t(`${ROOT}.untitled`);
}

/**
 * The placeholder a settings row shows when the connector could not tell us an
 * item's real name (describe not answered, failed, or the item is gone): the
 * localized kind label and a generic "name unavailable" note. Never the raw id,
 * which for some connectors is an opaque, meaningless identifier. */
export function unavailableItemName(
  t: Translate,
  connectorType: string,
  kind: string,
): string {
  return `${kindHeading(t, connectorType, kind)} · ${t(
    `${ROOT}.nameUnavailable`,
  )}`;
}

/**
 * The name a settings row shows: the real name when known, the untitled label
 * for an explicitly empty name, or — instead of the raw id — the localized
 * kind-based placeholder when the name is not known. */
export function itemRowName(
  t: Translate,
  name: string | null | undefined,
  connectorType: string,
  kind: string,
): string {
  if (name == null) return unavailableItemName(t, connectorType, kind);
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : t(`${ROOT}.untitled`);
}
