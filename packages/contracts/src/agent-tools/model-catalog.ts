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
