import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

const forwardedForHeader = "x-forwarded-for";
const realIpHeader = "x-real-ip";
const clientIpHeaders = [
  forwardedForHeader,
  realIpHeader,
  "cf-connecting-ip",
  "true-client-ip",
  "x-client-ip",
];

function normalizeRemoteAddress(value: string | undefined) {
  if (!value) {
    return null;
  }

  if (value.startsWith("::ffff:")) {
    return value.slice("::ffff:".length);
  }

  return value;
}

function getRemoteAddress(c: Context) {
  try {
    return normalizeRemoteAddress(getConnInfo(c).remote.address);
  } catch {
    return null;
  }
}

function getForwardedIp(headers: Headers) {
  for (const header of clientIpHeaders) {
    const value = headers.get(header)?.split(",")[0]?.trim();
    if (value) {
      return value;
    }
  }

  return null;
}

export function withBetterAuthClientIp(c: Context) {
  const request = c.req.raw;
  if (request.headers.get(forwardedForHeader)?.trim()) {
    return request;
  }

  const clientIp = getForwardedIp(request.headers) ?? getRemoteAddress(c);
  if (!clientIp) {
    return request;
  }

  const headers = new Headers(request.headers);
  headers.set(forwardedForHeader, clientIp);
  if (!headers.has(realIpHeader)) {
    headers.set(realIpHeader, clientIp);
  }

  return new Request(request, { headers });
}
