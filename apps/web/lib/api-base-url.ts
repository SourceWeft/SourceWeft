const DEFAULT_API_PORT = "3001";
const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLocalhostUrl(value: string) {
  try {
    const url = new URL(value);
    return LOCALHOST_NAMES.has(url.hostname);
  } catch {
    return false;
  }
}

function resolveBrowserApiBaseUrl(configured?: string) {
  if (typeof window === "undefined") {
    return configured || `http://localhost:${DEFAULT_API_PORT}`;
  }

  const configuredBaseUrl = configured?.trim();
  if (configuredBaseUrl && !isLocalhostUrl(configuredBaseUrl)) {
    return configuredBaseUrl.replace(/\/$/, "");
  }

  const { protocol, hostname } = window.location;
  if (!LOCALHOST_NAMES.has(hostname)) {
    return `${protocol}//${hostname}:${DEFAULT_API_PORT}`;
  }

  return (configuredBaseUrl || `http://localhost:${DEFAULT_API_PORT}`).replace(
    /\/$/,
    "",
  );
}

export const apiBaseUrl = resolveBrowserApiBaseUrl(
  process.env.NEXT_PUBLIC_API_BASE_URL,
);
