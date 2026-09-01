import { AsyncLocalStorage } from "node:async_hooks";

export interface ProviderResponseCapture {
  headers?: Headers;
  statusCode?: number;
}

const responseCaptureStorage = new AsyncLocalStorage<ProviderResponseCapture>();

export function createProviderResponseCapture(): ProviderResponseCapture {
  return {};
}

export function runWithProviderResponseCapture<T>(
  capture: ProviderResponseCapture,
  run: () => T,
): T {
  return responseCaptureStorage.run(capture, run);
}

export function captureProviderResponseFetch(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const capture = responseCaptureStorage.getStore();
    if (capture) {
      capture.headers = new Headers(response.headers);
      capture.statusCode = response.status;
    }
    return response;
  };
}
