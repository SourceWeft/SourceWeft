import type { SelectableInvocationDefinition } from "./types";

export type SelectableInvocationDefinitionWithAlias =
  SelectableInvocationDefinition & {
    alternateSlashAliases?: readonly string[];
    legacyIds?: readonly string[];
    slashAlias?: string;
  };

export type SelectableInvocationProvider = {
  id: string;
  enabled?: boolean;
  list: () => SelectableInvocationDefinitionWithAlias[];
};

export type SelectableInvocationRegistry = {
  list: () => SelectableInvocationDefinitionWithAlias[];
  resolve: (id: string) => SelectableInvocationDefinitionWithAlias | null;
  resolveAlias: (alias: string) => SelectableInvocationDefinitionWithAlias | null;
};

function normalizeSlashAlias(alias: string) {
  return alias.startsWith("/") ? alias : `/${alias}`;
}

export function createSelectableInvocationRegistry(input: {
  providers: SelectableInvocationProvider[];
}): SelectableInvocationRegistry {
  let cachedDefinitions: SelectableInvocationDefinitionWithAlias[] | null = null;
  let cachedAliasMap: Map<string, SelectableInvocationDefinitionWithAlias> | null = null;
  let cachedIdMap: Map<string, SelectableInvocationDefinitionWithAlias> | null = null;

  function build() {
    if (cachedDefinitions && cachedAliasMap && cachedIdMap) {
      return {
        aliasMap: cachedAliasMap,
        definitions: cachedDefinitions,
        idMap: cachedIdMap,
      };
    }

    const definitions: SelectableInvocationDefinitionWithAlias[] = [];
    const aliasMap = new Map<string, SelectableInvocationDefinitionWithAlias>();
    const idMap = new Map<string, SelectableInvocationDefinitionWithAlias>();

    for (const provider of input.providers) {
      if (provider.enabled === false) {
        continue;
      }
      for (const definition of provider.list()) {
        registerId(idMap, definition.id, definition, "id");
        for (const legacyId of definition.legacyIds ?? []) {
          registerId(idMap, legacyId, definition, "legacy id");
        }

        const slashAliases = [
          ...(definition.slashAlias ? [definition.slashAlias] : []),
          ...(definition.alternateSlashAliases ?? []),
        ];
        for (const slashAlias of slashAliases) {
          const alias = normalizeSlashAlias(slashAlias);
          if (aliasMap.has(alias)) {
            throw new Error(
              `SCHEMA_MISMATCH: Duplicate selectable invocation slash alias: ${alias}`,
            );
          }
          aliasMap.set(alias, definition);
        }

        definitions.push(definition);
      }
    }

    cachedDefinitions = definitions;
    cachedAliasMap = aliasMap;
    cachedIdMap = idMap;
    return { definitions, aliasMap, idMap };
  }

  function registerId(
    idMap: Map<string, SelectableInvocationDefinitionWithAlias>,
    id: string,
    definition: SelectableInvocationDefinitionWithAlias,
    label: "id" | "legacy id",
  ) {
    const existing = idMap.get(id);
    if (existing && existing !== definition) {
      if (label === "id") {
        throw new Error(
          `SCHEMA_MISMATCH: Duplicate selectable invocation id: ${definition.id}`,
        );
      }
      throw new Error(
        `SCHEMA_MISMATCH: Duplicate selectable invocation legacy id: ${id}`,
      );
    }
    idMap.set(id, definition);
  }

  return {
    list() {
      return [...build().definitions];
    },
    resolve(id) {
      return build().idMap.get(id) ?? null;
    },
    resolveAlias(alias) {
      return build().aliasMap.get(normalizeSlashAlias(alias)) ?? null;
    },
  };
}
