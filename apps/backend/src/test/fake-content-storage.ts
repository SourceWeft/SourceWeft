/**
 * In-memory stand-in for `modules/sources/storage` for tests that write skill
 * files through the registry. Mock factories are hoisted and cannot see a
 * file's imports, so the store stays a hoisted literal and the factory
 * reaches the fake with a dynamic import:
 *
 *   const store = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));
 *   vi.mock("../../sources/storage", async () =>
 *     (await import("../../../test/fake-content-storage")).fakeContentStorage(store),
 *   );
 *
 * The store is the test's own: inspect `objects` to assert what was written.
 */
export type ContentStorageStore = { objects: Map<string, Buffer> };

export function fakeContentStorage(store: ContentStorageStore) {
  return {
    getContentStorageBucketName: () => "bucket",
    sandboxAssetObjectExists: async ({ key }: { key: string }) =>
      store.objects.has(key),
    uploadFileObject: async (input: { key: string; body: Buffer }) => {
      store.objects.set(input.key, input.body);
      return { bucket: "bucket", key: input.key };
    },
  };
}
