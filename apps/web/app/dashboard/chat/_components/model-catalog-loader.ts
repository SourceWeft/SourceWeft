import { contentClient } from "../../../../lib/sdk";

export type ThreadModelSelectorCatalog = Awaited<
  ReturnType<typeof contentClient.listThreadModelSelectorCatalog>
>;

const MODEL_CATALOG_CACHE_TTL_MS = 60_000;

type CatalogEntry = {
  expiresAt: number;
  promise?: Promise<ThreadModelSelectorCatalog>;
  value?: ThreadModelSelectorCatalog;
};

const catalogByWorkspace = new Map<string, CatalogEntry>();

export function loadThreadModelSelectorCatalog(
  workspaceId: string,
  options: {
    load?: (workspaceId: string) => Promise<ThreadModelSelectorCatalog>;
    now?: () => number;
  } = {},
) {
  const now = options.now ?? Date.now;
  const cached = catalogByWorkspace.get(workspaceId);
  if (cached?.promise) {
    return cached.promise;
  }
  if (cached?.value && cached.expiresAt > now()) {
    return Promise.resolve(cached.value);
  }

  const load =
    options.load ??
    ((activeWorkspaceId: string) =>
      contentClient.listThreadModelSelectorCatalog(activeWorkspaceId));
  const entry: CatalogEntry = { expiresAt: 0 };
  const promise = load(workspaceId)
    .then((value) => {
      if (catalogByWorkspace.get(workspaceId) === entry) {
        entry.value = value;
        entry.promise = undefined;
        entry.expiresAt = now() + MODEL_CATALOG_CACHE_TTL_MS;
      }
      return value;
    })
    .catch((error) => {
      if (catalogByWorkspace.get(workspaceId) === entry) {
        catalogByWorkspace.delete(workspaceId);
      }
      throw error;
    });
  entry.promise = promise;
  catalogByWorkspace.set(workspaceId, entry);
  return promise;
}

export function resetThreadModelSelectorCatalogCacheForTests() {
  catalogByWorkspace.clear();
}
