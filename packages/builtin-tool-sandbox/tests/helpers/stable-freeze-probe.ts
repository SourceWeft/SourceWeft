import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { redactSandboxText } from "../../src/runtime/redaction";
import { sandboxErrorDiagnostic } from "../../src/runtime/errors";

export async function probeStableFreeze(driver: {
  provider: string;
  target?: Record<string, string>;
  create(purpose: string): Promise<string>;
  execute(
    id: string,
    command: string,
  ): Promise<{ output: string; exitCode: number | null }>;
  delete(id: string): Promise<void>;
}) {
  const log = process.env.SANDBOX_FREEZE_PROBE_LOG;
  if (!log)
    throw new Error(
      "SANDBOX_FREEZE_PROBE_LOG must retain the full safe probe log",
    );
  const runId = randomUUID();
  const emit = (event: Record<string, unknown>) => {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      provider: driver.provider,
      target: driver.target,
      runId,
      ...event,
    });
    appendFileSync(log, `${line}\n`, { mode: 0o600 });
    console.log(line);
  };
  let id: string | undefined;
  try {
    emit({ event: "creating", purpose: "stable-freeze-capability-228" });
    id = await driver.create(`stable-freeze-capability-228-${runId}`);
    emit({ event: "created", sandboxId: id });
    const script = readFileSync(
      new URL("../fixtures/stable-freeze-capability.py", import.meta.url),
      "utf8",
    );
    const result = await driver.execute(
      id,
      `python3 - <<'SWVOL_FREEZE_PROBE'\n${script}\nSWVOL_FREEZE_PROBE`,
    );
    emit({
      event: "probe-result",
      sandboxId: id,
      exitCode: result.exitCode,
      output: redactSandboxText(result.output),
    });
    if (result.exitCode !== 0)
      throw new Error(`Capability probe exited ${result.exitCode}`);
    if (process.env.SANDBOX_FREEZE_ASYNC_SYSCALLS === "1") {
      const asyncProbe = readFileSync(
        new URL("../fixtures/async-kernel-io-capability.py", import.meta.url),
        "utf8",
      );
      const checked = await driver.execute(
        id,
        `python3 - <<'SWVOL_ASYNC_PROBE'\n${asyncProbe}\nSWVOL_ASYNC_PROBE`,
      );
      emit({
        event: "async-kernel-io-capability",
        sandboxId: id,
        exitCode: checked.exitCode,
        output: redactSandboxText(checked.output),
      });
      if (checked.exitCode !== 0)
        throw new Error(
          `Async kernel I/O capability probe exited ${checked.exitCode}`,
        );
    }
    if (process.env.SANDBOX_FREEZE_KERNEL_TEST === "1") {
      const capability = JSON.parse(result.output.trim()) as {
        delegation?: { available?: boolean };
      };
      if (capability.delegation?.available !== true)
        throw new Error(
          "Kernel test blocked: own-child cgroup delegation was not verified",
        );
      const kernelProbe = readFileSync(
        new URL("../fixtures/cgroup-freezer-boundary.py", import.meta.url),
        "utf8",
      );
      const checked = await driver.execute(
        id,
        `python3 - <<'SWVOL_KERNEL_FREEZER_PROBE'\n${kernelProbe}\nSWVOL_KERNEL_FREEZER_PROBE`,
      );
      emit({
        event: "kernel-freezer",
        sandboxId: id,
        exitCode: checked.exitCode,
        output: redactSandboxText(checked.output),
      });
      if (checked.exitCode !== 0)
        throw new Error(`Kernel freezer probe exited ${checked.exitCode}`);
    }
    if (process.env.SANDBOX_FREEZE_ASYNC_BOUNDARY === "1") {
      const asyncBoundary = readFileSync(
        new URL("../fixtures/async-kernel-io-boundary.py", import.meta.url),
        "utf8",
      );
      const checked = await driver.execute(
        id,
        `python3 - <<'SWVOL_ASYNC_BOUNDARY'\n${asyncBoundary}\nSWVOL_ASYNC_BOUNDARY`,
      );
      emit({
        event: "async-kernel-io-boundary",
        sandboxId: id,
        exitCode: checked.exitCode,
        output: redactSandboxText(checked.output),
      });
      if (checked.exitCode !== 0)
        throw new Error(
          `Async kernel I/O boundary probe exited ${checked.exitCode}`,
        );
    }
    if (process.env.SANDBOX_FREEZE_NATIVE_AIO === "1") {
      const nativeAio = readFileSync(
        new URL("../fixtures/native-aio-freezer-boundary.py", import.meta.url),
        "utf8",
      );
      const checked = await driver.execute(
        id,
        `python3 - <<'SWVOL_NATIVE_AIO'\n${nativeAio}\nSWVOL_NATIVE_AIO`,
      );
      emit({
        event: "native-aio-freezer-boundary",
        sandboxId: id,
        exitCode: checked.exitCode,
        output: redactSandboxText(checked.output),
      });
      if (checked.exitCode !== 0)
        throw new Error(`Native AIO boundary probe exited ${checked.exitCode}`);
    }
    if (process.env.SANDBOX_FREEZE_SUPERVISOR_TEST === "1") {
      const expected = process.env.SANDBOX_FREEZE_SUPERVISOR_SHA;
      if (!expected || !/^[a-f0-9]{64}$/.test(expected))
        throw new Error("Reviewed post-AIO supervisor SHA is required");
      const sources = new URL(
        "../../../sandbox-volume/helper/swvol-supervisor/tests/fixtures/",
        import.meta.url,
      );
      const timer = readFileSync(
        new URL("posix_sigcont_writer.c", sources),
        "utf8",
      );
      const aio = readFileSync(new URL("native_aio_writer.c", sources), "utf8");
      const acceptance = readFileSync(
        new URL("../fixtures/supervisor-cgroup-cloud.py", import.meta.url),
        "utf8",
      );
      const script = `EXPECTED_SUPERVISOR_SHA=${JSON.stringify(expected)}\nTIMER_SOURCE=${JSON.stringify(timer)}\nAIO_SOURCE=${JSON.stringify(aio)}\n${acceptance}`;
      const checked = await driver.execute(
        id,
        `python3 - <<'SWVOL_SUPERVISOR_ACCEPTANCE'\n${script}\nSWVOL_SUPERVISOR_ACCEPTANCE`,
      );
      emit({
        event: "actual-supervisor-acceptance",
        sandboxId: id,
        exitCode: checked.exitCode,
        output: redactSandboxText(checked.output),
      });
      if (checked.exitCode !== 0)
        throw new Error(
          `Actual supervisor diagnostic acceptance exited ${checked.exitCode}`,
        );
    }
    const rounds = Number(process.env.SANDBOX_FREEZE_LIFECYCLE_ROUNDS ?? "0");
    if (!Number.isSafeInteger(rounds) || rounds < 0 || rounds > 3)
      throw new Error("Lifecycle rounds must be 0..3");
    if (rounds) {
      const lifecycle = readFileSync(
        new URL("../fixtures/pid-namespace-boundary.py", import.meta.url),
        "utf8",
      );
      for (let round = 1; round <= rounds; round++) {
        const checked = await driver.execute(
          id,
          `python3 - <<'SWVOL_LIFECYCLE_PROBE'\n${lifecycle}\nSWVOL_LIFECYCLE_PROBE`,
        );
        emit({
          event: "namespace-lifecycle",
          sandboxId: id,
          round,
          exitCode: checked.exitCode,
          output: redactSandboxText(checked.output),
        });
        if (checked.exitCode !== 0)
          throw new Error(
            `Namespace lifecycle round ${round} exited ${checked.exitCode}; no stable-freeze capability is inferred`,
          );
      }
    }
  } catch (error) {
    emit({
      event: "failed",
      sandboxId: id,
      error:
        error instanceof Error
          ? redactSandboxText(error.message)
          : "probe failed",
      diagnostic: sandboxErrorDiagnostic(error),
    });
    process.exitCode = 1;
  } finally {
    if (id) {
      try {
        await driver.delete(id);
        emit({ event: "deleted", sandboxId: id });
      } catch (error) {
        emit({
          event: "cleanup-failed",
          sandboxId: id,
          error:
            error instanceof Error
              ? redactSandboxText(error.message)
              : "cleanup failed",
        });
        process.exitCode = 1;
      }
    }
  }
}
