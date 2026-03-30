export function healthResponse() {
  return {
    status: "ok",
    service: "backend-api",
    timestamp: new Date().toISOString(),
  };
}
