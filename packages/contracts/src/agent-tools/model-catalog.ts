/**
 * What a capability adds to the model catalog the client browses.
 *
 * A model row is host data — alias, provider, pricing, routing. What that model
 * can *do for a capability* is not: only the capability that drives image
 * generation knows which aspect ratios a given provider honours, and only the
 * one that drives speech knows which voices exist. Without this hook the
 * catalog builder had to import a capability to annotate the rows of its kind.
 *
 * The annotation is applied to catalog rows whose model kind matches the tool's
 * declared `requirements.modelKind`, and lands under the capability's own `key`
 * inside the row's `capabilities` record. The builder never reads the value.
 */

export type AgentToolModelCatalogInput = {
  /** The operator-supplied config blob attached to the model's profile. */
  readonly configJson: Readonly<Record<string, unknown>>;
  /** The provider the model routes to, when routing is configured. */
  readonly providerKind?: string | null;
  /** The upstream model id the route targets, when configured. */
  readonly modelId?: string | null;
};

export type AgentToolModelCatalogAnnotation = {
  /** Property name this annotation occupies under the row's `capabilities`. */
  readonly key: string;
  /** Describe the model in the capability's own vocabulary. */
  describe(input: AgentToolModelCatalogInput): unknown;
};

/**
 * The other end of the annotation above: a pointer from a capability's *option*
 * back into the annotation, saying "the values I can offer are whatever the
 * selected model advertises here".
 *
 * A configurable option lists every value the capability understands, but not
 * every model honours every one of them — the picker must be narrowed per
 * model. The narrowing rule is capability vocabulary end to end: which
 * annotation carries the answer, and where inside it the supported values live.
 * Without this pointer the client had to hardcode that mapping, which meant one
 * host-side branch per capability with model-constrained options.
 *
 * Declaring it lets the client resolve the pointer blind: read `key` off the
 * selected model's `capabilities` record, walk `path`, intersect. The client
 * never learns what the option means, and adding a capability with
 * model-constrained options needs no host edit.
 */
export type AgentToolModelCatalogValues = {
  /** Annotation to read, matching {@link AgentToolModelCatalogAnnotation.key}. */
  readonly key: string;
  /**
   * Dotted path inside that annotation to an array of supported values, e.g.
   * `"controls.aspectRatio.values"`.
   */
  readonly path: string;
};

/**
 * Resolve a {@link AgentToolModelCatalogValues} pointer against the capability
 * annotations advertised by the selected model(s).
 *
 * Returns null when anything along the way is absent — no declaration, no
 * annotation for that key, a path that does not land on an array. Absent is not
 * "nothing is supported": a model that advertises nothing constrains nothing,
 * so callers fall back to the full declared list rather than showing an empty
 * picker.
 */
export function resolveModelCatalogValues(
  modelCapabilities: Readonly<Record<string, unknown>> | null | undefined,
  source: AgentToolModelCatalogValues | null | undefined,
): readonly unknown[] | null {
  if (!source || !modelCapabilities) {
    return null;
  }
  let cursor: unknown = modelCapabilities[source.key];
  for (const segment of source.path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return Array.isArray(cursor) && cursor.length > 0 ? cursor : null;
}

/**
 * Narrow an option's declared values to those the selected model advertises.
 *
 * Values the model does not list are dropped; a value that is not a string is
 * kept, because the model-advertised lists are string enumerations and a
 * numeric or boolean option has no way to appear in one — dropping those would
 * silently empty the picker instead of leaving it unconstrained.
 */
export function filterModelSupportedOptionValues<
  Value extends { readonly value: unknown },
>(
  values: readonly Value[],
  source: AgentToolModelCatalogValues | null | undefined,
  modelCapabilities: Readonly<Record<string, unknown>> | null | undefined,
): readonly Value[] {
  const supportedValues = resolveModelCatalogValues(modelCapabilities, source);
  if (!supportedValues) {
    return values;
  }
  const supported = new Set(supportedValues);
  return values.filter(
    (candidate) =>
      typeof candidate.value !== "string" || supported.has(candidate.value),
  );
}
