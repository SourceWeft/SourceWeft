import "dotenv/config";
import { BUILTIN_CAPABILITY_MODULES } from "@sourceweft/agent-tool-registry/server";
import { config } from "../shared/config";
import {
  getSandboxProviderFactory,
  initializeSandboxProviderRegistry,
} from "../modules/threads/agent/sandbox-service/provider-registry";

type CapabilityBenchmark = {
  id: string;
  run(input: Record<string, unknown>): Promise<unknown>;
};

function asCapabilityBenchmark(value: unknown): CapabilityBenchmark | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { id?: unknown; run?: unknown };
  return typeof candidate.id === "string" && typeof candidate.run === "function"
    ? (candidate as CapabilityBenchmark)
    : null;
}

const requestedId = process.argv[2]?.trim() || null;
const benchmarks: CapabilityBenchmark[] = [];
for (const load of Object.values(BUILTIN_CAPABILITY_MODULES)) {
  const module = await load();
  const benchmark = asCapabilityBenchmark(module.sandboxCapabilityBenchmark);
  if (benchmark && (!requestedId || benchmark.id === requestedId)) {
    benchmarks.push(benchmark);
  }
}
if (benchmarks.length !== 1) {
  throw new Error(
    `Expected exactly one sandbox capability benchmark${requestedId ? ` named '${requestedId}'` : ""}; found ${benchmarks.length}.`,
  );
}

await initializeSandboxProviderRegistry();
const factory = getSandboxProviderFactory(config.sandbox.provider);
const status = factory?.getConfigurationStatus();
if (!factory || !status?.configured) {
  throw new Error(
    `Configured sandbox provider '${config.sandbox.provider}' is unavailable: ${(status?.missing ?? []).join(", ")}`,
  );
}

const report = await benchmarks[0]!.run({
  providerId: config.sandbox.provider,
  provider: factory.createProvider(),
  limits: {
    ttlSeconds: config.sandbox.ttlSeconds,
    batchCommandTimeoutMs: config.sandbox.batchCommandTimeoutMs,
    maxCommandTimeoutMs: config.sandbox.maxCommandTimeoutMs,
    maxOutputChars: config.sandbox.maxOutputChars,
    maxPrepareFileBytes: config.sandbox.maxPrepareFileBytes,
    maxPrepareTotalBytes: config.sandbox.maxPrepareTotalBytes,
    maxCollectFileBytes: config.sandbox.maxCollectFileBytes,
    maxCollectTotalBytes: config.sandbox.maxCollectTotalBytes,
  },
});
console.log(JSON.stringify(report, null, 2));
if (
  report &&
  typeof report === "object" &&
  "passed" in report &&
  report.passed === false
) {
  process.exitCode = 1;
}
