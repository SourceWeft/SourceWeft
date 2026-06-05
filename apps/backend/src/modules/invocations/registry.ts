import type { SelectableInvocationDefinition } from "./types";

export type SelectableInvocationDefinitionWithAlias =
  SelectableInvocationDefinition & {
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

  function build() {
    if (cachedDefinitions && cachedAliasMap) {
      return { definitions: cachedDefinitions, aliasMap: cachedAliasMap };
    }

    const definitions: SelectableInvocationDefinitionWithAlias[] = [];
    const ids = new Set<string>();
    const aliasMap = new Map<string, SelectableInvocationDefinitionWithAlias>();

    for (const provider of input.providers) {
      if (provider.enabled === false) {
        continue;
      }
      for (const definition of provider.list()) {
        if (ids.has(definition.id)) {
          throw new Error(
            `SCHEMA_MISMATCH: Duplicate selectable invocation id: ${definition.id}`,
          );
        }
        ids.add(definition.id);

        if (definition.slashAlias) {
          const alias = normalizeSlashAlias(definition.slashAlias);
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
    return { definitions, aliasMap };
  }

  return {
    list() {
      return [...build().definitions];
    },
    resolve(id) {
      return build().definitions.find((definition) => definition.id === id) ?? null;
    },
    resolveAlias(alias) {
      return build().aliasMap.get(normalizeSlashAlias(alias)) ?? null;
    },
  };
}
