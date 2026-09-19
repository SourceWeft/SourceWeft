export function healthResponse() {
  return {
    status: "ok",
    service: "backend-api",
    commit: process.env.BUILD_SHA || "dev",
    timestamp: new Date().toISOString(),
  };
}
