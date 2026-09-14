import { publicRuntimeConfig } from "./public-runtime-config";

// All browser HTTP, authentication, SSE and websocket clients share this origin.
export const apiBaseUrl =
  publicRuntimeConfig().apiBaseUrl.replace(/\/$/, "") ||
  (typeof window !== "undefined"
    ? window.location.origin
    : "http://localhost:3001");
