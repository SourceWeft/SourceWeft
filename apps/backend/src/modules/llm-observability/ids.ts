import { randomUUID } from "node:crypto";

function prefixedId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

export function createTraceId() {
  return prefixedId("trace");
}

export function createSpanId() {
  return prefixedId("span");
}

export function createGenerationId() {
  return prefixedId("gen");
}

export function createAuditAccessLogId() {
  return prefixedId("audit");
}

export function createDatabaseId() {
  return randomUUID();
}
