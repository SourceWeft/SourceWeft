export type CheckStatus = "ok" | "warn" | "error" | "skipped";

export type CheckResult = {
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
  hints?: string[];
  durationMs: number;
};

export type CheckContext = {
  json: boolean;
};

export type CheckRunner = (context: CheckContext) => Promise<CheckResult>;

export function overallCheckStatus(results: CheckResult[]): CheckStatus {
  if (results.some((result) => result.status === "error")) {
    return "error";
  }

  if (results.some((result) => result.status === "warn")) {
    return "warn";
  }

  if (results.length > 0 && results.every((result) => result.status === "skipped")) {
    return "skipped";
  }

  return "ok";
}
