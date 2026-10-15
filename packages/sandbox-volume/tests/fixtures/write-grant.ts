import type { ObjectStore, WriteOnceGrant } from "../../src/store/object-store";
/** Explicit simulated capability lifetime for string-key test stores; never used by production. */
export async function fixtureWriteGrant(
  this: Pick<ObjectStore, "presignWriteOnce">,
  key: string,
  ttl = 3600,
): Promise<WriteOnceGrant> {
  return {
    url: await this.presignWriteOnce(key, ttl),
    expiresAt: new Date(Date.now() + ttl * 1000),
  };
}
