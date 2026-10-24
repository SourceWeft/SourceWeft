import {
  IconFetchError,
  type IconFetcher,
  type IconRequestOptions,
} from "./icon-fetcher";
import type { IconStateStore } from "./icon-state";
import { validateImage } from "./image-validate";
import { brandLabel } from "./site-domain";
import type { HashedIconStore } from "./store";

/**
 * One candidate image, end to end: fetch it (bounded, robots-checked unless
 * the host is a fixed one), validate the bytes, and store an accepted image
 * under its content hash. What comes back is the part of an `IconCandidate`
 * that depends on the image alone.
 */

export type ImageOutcome = {
  sha256?: string;
  width?: number;
  height?: number;
  storedUrl?: string;
  rejection?: string;
};

/** A failure that says nothing about the image: try again later. */
export class TransientIconError extends Error {
  constructor(
    readonly code: string,
    readonly deferred: boolean,
  ) {
    super(code);
    this.name = "TransientIconError";
  }
}

export type ImageDeps = {
  state: IconStateStore;
  store: HashedIconStore;
};

export async function fetchCandidateImage(
  fetcher: IconFetcher,
  url: string,
  request: IconRequestOptions,
  deps: ImageDeps,
  /** The registrable domain serving the image, for the shared-template signal. */
  servedBy?: string,
): Promise<ImageOutcome> {
  let response;
  try {
    response = await fetcher.checkedFetch(url, "image", request);
  } catch (error) {
    if (error instanceof IconFetchError) {
      switch (error.code) {
        case "robots-unavailable":
          throw new TransientIconError(error.code, true);
        case "timeout":
        case "network":
          throw new TransientIconError(error.code, false);
        default:
          return { rejection: error.code };
      }
    }
    throw error;
  }
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 429 || response.status >= 500) {
      throw new TransientIconError(`http-${response.status}`, false);
    }
    return { rejection: `http-${response.status}` };
  }
  const verdict = await validateImage(response.body);
  if (!verdict.ok) {
    return {
      rejection: verdict.reason,
      sha256: verdict.sha256,
      width: verdict.width,
      height: verdict.height,
    };
  }
  const stored = await deps.store({
    sha256: verdict.sha256,
    bytes: verdict.bytes,
    contentType: verdict.contentType,
  });
  if (servedBy) {
    await deps.state.recordHashDomain({
      sha256: verdict.sha256,
      domain: servedBy,
      label: brandLabel(servedBy),
    });
  }
  return {
    sha256: verdict.sha256,
    width: verdict.width,
    height: verdict.height,
    storedUrl: stored.url,
  };
}
