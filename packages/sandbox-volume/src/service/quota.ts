import { MAX_FILE_BYTES } from "../protocol/constants";
export type VolumeLimits = {
  maxLogicalBytes: number;
  maxFileBytes: number;
  maxEntries: number;
  /** Registered retained packs plus durable repair reservations. General pending uploads are not fully inventoried. */
  maxObjectBytes: number;
};
export const DEFAULT_VOLUME_LIMITS: Readonly<VolumeLimits> = {
  maxLogicalBytes: 32 * 1024 ** 3,
  maxFileBytes: MAX_FILE_BYTES,
  maxEntries: 500_000,
  maxObjectBytes: 64 * 1024 ** 3,
};
export function resolveVolumeLimits(
  input: Partial<VolumeLimits> = {},
): VolumeLimits {
  const limits = { ...DEFAULT_VOLUME_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`invalid volume limit ${name}`);
  if (limits.maxFileBytes > MAX_FILE_BYTES)
    throw new Error("maxFileBytes exceeds the current helper protocol limit");
  return limits;
}
export class VolumeQuotaExceeded extends Error {
  override readonly name = "VolumeQuotaExceeded";
  constructor(
    readonly resource: keyof VolumeLimits,
    readonly actual: number,
    readonly limit: number,
  ) {
    super(`volume quota exceeded: ${resource} (${actual} > ${limit})`);
  }
}
export function enforceVolumeLimits(
  limits: VolumeLimits,
  usage: VolumeLimits,
): void {
  for (const name of Object.keys(limits) as Array<keyof VolumeLimits>)
    if (usage[name] > limits[name])
      throw new VolumeQuotaExceeded(name, usage[name], limits[name]);
}
