import "dotenv/config";
import { afterEach, vi } from "vitest";

process.env.LLM_OBSERVABILITY_WRITES_DISABLED ??= "1";

afterEach(() => {
  vi.restoreAllMocks();
});
