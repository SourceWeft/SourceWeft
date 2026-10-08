import { randomUUID } from "node:crypto";
import {
  EXIT_NEED_SLOTS,
  EXIT_PACK_UNREADABLE,
  TAIL_MARKER,
} from "../protocol/constants";
import { parseCommandOutput } from "../protocol/marker";
import type { FlushReport } from "../protocol/types";
import type { AttachmentRow, VolumeScope } from "../service/repository";
import type { ApplyWalResult, VolumeService } from "../service/volume-service";

/** The one thing the hooks need from a sandbox: run a shell command and get its combined output and exit code. */
export type SandboxExecutor = {
  execute(
    command: string,
    options: { timeoutMs: number },
  ): Promise<{ output: string; exitCode: number | null }>;
};

export type HelperSource = {
  /** Where the image ships the helper (preferred). */
  imagePath?: string;
  /** Fallback for images without the helper: a pre-signed GET URL for the static binary. */
  downloadUrl?: () => Promise<string>;
};

export type VolumeHooksConfig = {
  service: VolumeService;
  helper: HelperSource;
  /** Volume root inside the sandbox. */
  root?: string;
  /** Helper state directory; must not be inside the synced tree except as `<root>/.sourceweft`. */
  stateDir?: string;
  /** Shadow mode: sync (daemon + barrier) but never restore into the sandbox. */
  shadow?: boolean;
  log?: (event: string, fields: Record<string, unknown>) => void;
};

export type AttachResult = {
  volumeId: string;
  attachmentId: string;
  /** Helper's restore report (null in shadow mode). */
  restore: Record<string, unknown> | null;
  daemon: boolean;
  repairs: Array<Record<string, unknown>>;
  durationMs: number;
  /** Raw output of the attach command, for diagnostics. */
  output: string;
};

export type ParsedExecuteResult = {
  output: string;
  exitCode: number | null;
  sync: {
    /** True when the barrier reported a successful commit (or there was nothing to commit). */
    persisted: boolean;
    confirmedSeq: number;
    mode: "shadow" | "full";
    flushExitCode: number | null;
    flush: FlushReport | null;
    wal: ApplyWalResult | null;
    rebase: { applied: number; stillRejected: boolean } | null;
    /** Packs the helper could not read; already repaired when present. */
    repaired: string[];
  };
};

export class ContainerReplacedError extends Error {
  override readonly name = "ContainerReplacedError";
  readonly commandStarted = false;
  constructor(readonly attachmentId: string) {
    super(
      "the sandbox container was replaced; the volume must be re-attached before running commands",
    );
  }
}

export class VolumePersistenceError extends Error {
  override readonly name = "VolumePersistenceError";
  readonly code = "SANDBOX_VOLUME_PERSISTENCE_UNCONFIRMED";
  commandOutput?: string;
  commandExitCode?: number | null;
  durabilityStatus: "unknown" | "failed" = "unknown";
  constructor(
    readonly attachmentId: string,
    reason: string,
  ) {
    super(
      `Sandbox volume persistence is unconfirmed: ${reason}. The user command may already have run; do not execute it again automatically.`,
    );
  }
}

function confirmedFlush(
  report: FlushReport | null,
): report is FlushReport & { ok: true; seq: number } {
  return (
    report !== null &&
    !Array.isArray(report) &&
    report.ok === true &&
    typeof report.seq === "number" &&
    Number.isSafeInteger(report.seq) &&
    report.seq >= 0 &&
    (report.unstable === undefined || report.unstable === 0) &&
    (report.unreadable === undefined ||
      (Array.isArray(report.unreadable) && report.unreadable.length === 0)) &&
    (report.skipped === undefined ||
      (Array.isArray(report.skipped) && report.skipped.length === 0)) &&
    !report.error
  );
}

const DEFAULT_ROOT = "/workspace";
export const REQUIRED_HELPER_VERSION = "0.2.0";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The five integration points of the volume in the sandbox lifecycle. Everything else
 * (manifests, slots, packs, restore plans) stays inside this package.
 */
export function createVolumeHooks(config: VolumeHooksConfig) {
  const { service } = config;
  const root = config.root ?? DEFAULT_ROOT;
  const meta = config.stateDir ?? `${root}/.sourceweft`;
  const helperPath = config.helper.imagePath ?? `${meta}/bin/swvol`;
  const log = config.log ?? (() => undefined);
  const shadowScopes = new Map<string, VolumeScope>();
  const scopeKey = (scope: VolumeScope) =>
    JSON.stringify([scope.teamId, scope.workspaceId, scope.threadId]);

  function replaceSlots(url: string): string {
    return `__swvol_slots=$(mktemp ${shellQuote(`${meta}/slots.XXXXXX`)}) && curl -fsS --speed-limit 20000 --speed-time 5 --max-time 60 --retry 2 -o "$__swvol_slots" ${shellQuote(url)} && mv "$__swvol_slots" ${shellQuote(`${meta}/slots.json`)}`;
  }

  async function bootstrapCommand(): Promise<string> {
    const checkVersion = `[ "$(${shellQuote(helperPath)} version)" = ${shellQuote(`swvol ${REQUIRED_HELPER_VERSION}`)} ] || { echo 'swvol: incompatible helper version' >&2; exit 90; }`;
    if (config.helper.imagePath)
      return `[ -x ${shellQuote(config.helper.imagePath)} ] || exit 90\n${checkVersion}`;
    if (!config.helper.downloadUrl)
      throw new Error("no helper source configured");
    const url = await config.helper.downloadUrl();
    return `mkdir -p ${shellQuote(`${meta}/bin`)} && { [ -x ${shellQuote(helperPath)} ] || { curl -fsS --speed-limit 100000 --speed-time 5 --max-time 120 --retry 2 -o ${shellQuote(`${helperPath}.tmp`)} ${shellQuote(url)} && chmod 755 ${shellQuote(`${helperPath}.tmp`)} && mv ${shellQuote(`${helperPath}.tmp`)} ${shellQuote(helperPath)}; }; } || exit 90\n${checkVersion}`;
  }

  async function attachOnce(
    attachment: AttachmentRow,
    executor: SandboxExecutor,
    repairs: Array<Record<string, unknown>>,
  ): Promise<AttachResult> {
    const started = Date.now();
    const files = await service.publishAttachFiles(attachment);
    const restore = config.shadow
      ? `${shellQuote(helperPath)} restore --root ${shellQuote(root)} --plan ${shellQuote(files.planUrl)} --index-only; rc=$?`
      : `${shellQuote(helperPath)} restore --root ${shellQuote(root)} --plan ${shellQuote(files.planUrl)}; rc=$?`;
    const command = [
      await bootstrapCommand(),
      `mkdir -p ${shellQuote(meta)}`,
      `if [ -f ${shellQuote(`${meta}/daemon.pid`)} ]; then kill "$(cat ${shellQuote(`${meta}/daemon.pid`)})" 2>/dev/null; sleep 0.2; fi`,
      `${replaceSlots(files.slotsUrl)} || exit 91`,
      restore,
      `[ "$rc" -eq 0 ] || exit "$rc"`,
      // stdin must not stay attached to the exec stream: the bridge would wait for the daemon to close it.
      `nohup setsid ${shellQuote(helperPath)} daemon --root ${shellQuote(root)} > ${shellQuote(`${meta}/daemon.log`)} 2>&1 < /dev/null &`,
      `for i in $(seq 1 50); do [ -S ${shellQuote(`${meta}/sock`)} ] && break; sleep 0.05; done`,
      `[ -S ${shellQuote(`${meta}/sock`)} ] || { echo DAEMON_DOWN; exit 92; }`,
      `echo DAEMON_UP`,
    ].join("\n");
    const result = await executor.execute(command, { timeoutMs: 900_000 });
    const output = result.output ?? "";
    let info: Record<string, unknown> | null = null;
    for (const line of output.split("\n")) {
      if (line.startsWith("{")) {
        try {
          info = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // not the helper's report
        }
      }
    }
    if (result.exitCode === 91 && repairs.length < 3) {
      repairs.push({ bootstrapDownloadFailed: result.exitCode });
      log("volume.attach.bootstrap_retry", {
        attachmentId: attachment.id,
        exitCode: result.exitCode,
      });
      return attachOnce(attachment, executor, repairs);
    }
    const unreadable = Array.isArray(info?.unreadable)
      ? (info!.unreadable as string[])
      : [];
    if (
      result.exitCode === EXIT_PACK_UNREADABLE &&
      unreadable.length &&
      repairs.length < 3
    ) {
      const repointed: string[] = [];
      for (const key of unreadable)
        repointed.push(await service.repairPack(attachment.volumeId, key));
      repairs.push({ unreadable, repointed });
      log("volume.attach.pack_repaired", {
        attachmentId: attachment.id,
        unreadable,
      });
      return attachOnce(attachment, executor, repairs);
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `volume attach failed (exit ${result.exitCode}): ${output.slice(-600)}`,
      );
    }
    const bootId = typeof info?.boot_id === "string" ? info.boot_id : null;
    if (
      !bootId ||
      info?.ok !== true ||
      !output.split("\n").includes("DAEMON_UP")
    ) {
      throw new VolumePersistenceError(
        attachment.id,
        "attach did not prove a restored identity and running daemon",
      );
    }
    await service.recordBootId(attachment.id, bootId);
    return {
      volumeId: attachment.volumeId,
      attachmentId: attachment.id,
      restore: info,
      daemon: output.includes("DAEMON_UP"),
      repairs,
      durationMs: Date.now() - started,
      output: output.slice(-2000),
    };
  }

  return {
    /** Bind a (new or replaced) sandbox container to the thread's volume and restore it. */
    async attach(input: {
      scope: VolumeScope;
      sandboxId: string;
      executor: SandboxExecutor;
    }): Promise<AttachResult> {
      const scope = config.shadow
        ? { ...input.scope, namespace: `shadow:${randomUUID()}` }
        : input.scope;
      const volume = await service.getOrCreateVolume(scope);
      const previous = await service.repo.activeAttachment(volume.id);
      if (previous) {
        // Another backend process may already own a healthy daemon. Resume only
        // that same instance; restoring here would discard its unflushed writes.
        if (previous.sandboxId !== input.sandboxId || !previous.bootId)
          throw new VolumePersistenceError(
            previous.id,
            "an existing attachment requires explicit recovery before replacement",
          );
        const probe = await input.executor.execute(
          `[ -x ${shellQuote(helperPath)} ] && [ "$(${shellQuote(helperPath)} version)" = ${shellQuote(`swvol ${REQUIRED_HELPER_VERSION}`)} ] && ${shellQuote(helperPath)} check --root ${shellQuote(root)} && [ "$(sed -n '1p' ${shellQuote(`${meta}/identity`)})" = ${shellQuote(previous.id)} ] && [ "$(sed -n '2p' ${shellQuote(`${meta}/identity`)})" = ${shellQuote(previous.bootId)} ] && [ -S ${shellQuote(`${meta}/sock`)} ]`,
          { timeoutMs: 10_000 },
        );
        if (probe.exitCode !== 0)
          throw new VolumePersistenceError(
            previous.id,
            "existing attachment identity or daemon could not be resumed",
          );
        await service.assertAttachmentActive(previous.id);
        await service.applyWal(previous.id);
        return {
          volumeId: volume.id,
          attachmentId: previous.id,
          restore: { resumed: true },
          daemon: true,
          repairs: [],
          durationMs: 0,
          output: "ATTACHMENT_RESUMED",
        };
      }
      const attachment = await service.attach(volume.id, input.sandboxId);
      const result = await attachOnce(attachment, input.executor, []);
      if (config.shadow) shadowScopes.set(scopeKey(input.scope), scope);
      log("volume.attach", {
        volumeId: volume.id,
        attachmentId: attachment.id,
        durationMs: result.durationMs,
        daemon: result.daemon,
        repairs: result.repairs.length,
      });
      return result;
    },

    /**
     * Wrap a user command: identity check, the command, the sync barrier, one marker line.
     * The user command never runs in a replaced container (exit 75 instead).
     */
    wrapCommand(command: string, options: { full?: boolean } = {}): string {
      const check = `[ -x ${shellQuote(helperPath)} ] && ${shellQuote(helperPath)} check --root ${shellQuote(root)}`;
      const flush = `${shellQuote(helperPath)} flush --root ${shellQuote(root)}${options.full ? " --full" : ""} > "$__swvol_report" 2> "$__swvol_report.err"; __swvol_frc=$?`;
      return [
        `if ${check}; then`,
        `__swvol_report=$(mktemp ${shellQuote(`${meta}/flush.XXXXXX`)}) || { printf '\\n${TAIL_MARKER} 78 {"ok":false,"reason":"report_allocation_failed"}\\n'; exit 78; }`,
        `trap 'rm -f "$__swvol_report" "$__swvol_report.err"' EXIT`,
        `( eval ${shellQuote(command)} ); __swvol_rc=$?`,
        flush,
        `printf '\\n${TAIL_MARKER} %s %s\\n' "$__swvol_frc" "$(head -c 4000 "$__swvol_report")"`,
        `exit "$__swvol_rc"`,
        // A failed check does not prove replacement: the helper or identity may
        // be damaged while unsaved files still exist. Never authorize replay here.
        `else printf '\\n${TAIL_MARKER} 79 {"ok":false,"reason":"instance_check_unavailable"}\\n'; exit 79; fi`,
      ].join("\n");
    },

    /**
     * Strip the marker, apply the WAL, handle a rejected chain (rebase) and unreadable packs.
     * Throws ContainerReplacedError when the wrapper refused to run the command.
     */
    async parseResult(input: {
      attachmentId: string;
      output: string;
      exitCode: number | null;
      executor: SandboxExecutor;
    }): Promise<ParsedExecuteResult> {
      const parsed = parseCommandOutput(input.output);
      try {
        if (!parsed.markerFound || input.exitCode === null) {
          throw new VolumePersistenceError(
            input.attachmentId,
            "missing completion or flush marker",
          );
        }
        if (parsed.instanceChanged) {
          throw new VolumePersistenceError(
            input.attachmentId,
            "command output cannot prove that an instance changed before execution",
          );
        }
        const wal = await service.applyWal(input.attachmentId);
        let verifiedWal = wal;
        let verifiedFlush = parsed.flush;
        let verifiedFlushExit = parsed.flushExitCode;
        // Only retry the barrier: the user command has already run. A bounded renewal
        // handles exhausted slots without ever replaying that command.
        for (
          let attempt = 0;
          attempt < 3 &&
          (verifiedFlushExit === EXIT_NEED_SLOTS ||
            verifiedFlush?.exit_code === EXIT_NEED_SLOTS);
          attempt++
        ) {
          const attachment = await service.repo.getAttachment(
            input.attachmentId,
          );
          if (!attachment || attachment.status !== "active")
            throw new VolumePersistenceError(
              input.attachmentId,
              "slot renewal requires an active attachment",
            );
          const slotsUrl = await service.publishSlots(attachment);
          const retry = await input.executor.execute(
            `${replaceSlots(slotsUrl)} && ${shellQuote(helperPath)} flush --root ${shellQuote(root)} --full`,
            { timeoutMs: 600_000 },
          );
          verifiedFlushExit = retry.exitCode;
          try {
            verifiedFlush = JSON.parse(retry.output) as FlushReport;
          } catch {
            verifiedFlush = null;
          }
          verifiedWal = await service.applyWal(input.attachmentId);
        }
        let rebase: ParsedExecuteResult["sync"]["rebase"] = null;
        const slotTaken =
          typeof verifiedFlush?.error === "string" &&
          verifiedFlush.error.startsWith("MANIFEST_SLOT_TAKEN");
        if (verifiedWal.rejected || slotTaken) {
          const { slotsUrl, head } = await service.beginRebase(
            input.attachmentId,
          );
          const rb = await input.executor.execute(
            `${replaceSlots(slotsUrl)} && ${shellQuote(helperPath)} flush --root ${shellQuote(root)} --rebase ${head}`,
            { timeoutMs: 600_000 },
          );
          const wal2 = await service.applyWal(input.attachmentId);
          verifiedWal = wal2;
          verifiedFlushExit = rb.exitCode;
          try {
            verifiedFlush = JSON.parse(rb.output) as FlushReport;
          } catch {
            verifiedFlush = null;
          }
          rebase = {
            applied: wal2.applied,
            stillRejected: wal2.rejected !== null,
          };
          log("volume.rebase", {
            attachmentId: input.attachmentId,
            reason: wal.rejected ?? "slot taken",
            exitCode: rb.exitCode,
            applied: wal2.applied,
            stillRejected: rebase.stillRejected,
          });
        }
        const repaired: string[] = [];
        const unreadable = Array.isArray(parsed.flush?.unreadable)
          ? parsed.flush!.unreadable!
          : [];
        if (unreadable.length) {
          const attachment = await service.repo.getAttachment(
            input.attachmentId,
          );
          if (attachment)
            for (const key of unreadable)
              repaired.push(await service.repairPack(attachment.volumeId, key));
        }
        if (
          verifiedFlushExit !== 0 ||
          !confirmedFlush(verifiedFlush) ||
          verifiedWal.rejected ||
          (rebase !== null && rebase.stillRejected)
        ) {
          const error = new VolumePersistenceError(
            input.attachmentId,
            "flush or WAL application failed",
          );
          error.durabilityStatus = "failed";
          throw error;
        }
        if (
          !(await service.confirmPersistence(
            input.attachmentId,
            verifiedFlush.seq,
          ))
        ) {
          throw new VolumePersistenceError(
            input.attachmentId,
            "database has not confirmed this active attachment's sequence",
          );
        }
        const persisted = true;
        return {
          output: parsed.output,
          exitCode: input.exitCode,
          sync: {
            persisted,
            confirmedSeq: verifiedFlush.seq,
            mode: config.shadow ? "shadow" : "full",
            flushExitCode: verifiedFlushExit,
            flush: verifiedFlush,
            wal: verifiedWal,
            rebase,
            repaired,
          },
        };
      } catch (error) {
        if (error instanceof ContainerReplacedError) throw error;
        const failure =
          error instanceof VolumePersistenceError
            ? error
            : new VolumePersistenceError(
                input.attachmentId,
                "the host could not verify the persistence result",
              );
        failure.commandOutput = parsed.output;
        failure.commandExitCode = input.exitCode;
        throw failure;
      }
    },

    async assertActive(input: {
      attachmentId: string;
      executor: SandboxExecutor;
    }): Promise<void> {
      await service.assertAttachmentActive(input.attachmentId);
      const actor = await service.repo.getAttachment(input.attachmentId);
      if (!actor?.bootId)
        throw new VolumePersistenceError(
          input.attachmentId,
          "attachment has no confirmed instance identity",
        );
      // This is a separate host execution before the user command is submitted.
      // Missing/corrupt identity is not replacement. A changed boot may still have
      // a persistent upper with dirty files, so it also requires explicit recovery.
      const probe = await input.executor.execute(
        `__swvol_boot=$(/bin/cat /proc/sys/kernel/random/boot_id) || exit 79; printf '__SWVOL_BOOT__ %s\\n' "$__swvol_boot"; [ -x ${shellQuote(helperPath)} ] || exit 79; [ "$(${shellQuote(helperPath)} version)" = ${shellQuote(`swvol ${REQUIRED_HELPER_VERSION}`)} ] || exit 79; ${shellQuote(helperPath)} check --root ${shellQuote(root)}`,
        { timeoutMs: 10_000 },
      );
      const boot = /^__SWVOL_BOOT__ ([0-9a-f-]{36})\r?\n/.exec(
        probe.output,
      )?.[1];
      if (!boot)
        throw new VolumePersistenceError(
          input.attachmentId,
          "instance identity probe did not complete",
        );
      if (boot !== actor.bootId)
        throw new VolumePersistenceError(
          input.attachmentId,
          "instance boot changed; preserve its writable files until explicit recovery",
        );
      if (probe.exitCode !== 0)
        throw new VolumePersistenceError(
          input.attachmentId,
          "helper state is unavailable in the existing instance; preserving its files",
        );
    },

    async quarantine(input: {
      attachmentId: string;
      reason: string;
    }): Promise<void> {
      await service.quarantineAttachment(input.attachmentId, input.reason);
    },

    /**
     * Checkpoint by scope, for processes that did not attach the sandbox themselves (the cleanup
     * worker). Applies whatever the sandbox uploaded even when the container is already gone.
     */
    async checkpointScope(input: {
      scope: VolumeScope;
      sandboxId: string;
      executor: SandboxExecutor;
    }): Promise<ParsedExecuteResult | null> {
      const scope = config.shadow
        ? shadowScopes.get(scopeKey(input.scope))
        : input.scope;
      // A new cleanup process must never checkpoint the primary volume with shadow hooks.
      if (!scope) return null;
      const volume = await service.repo.findVolume(scope);
      if (!volume) return null;
      const attachment = await service.repo.activeAttachment(volume.id);
      if (!attachment)
        throw new VolumePersistenceError(
          volume.id,
          "volume has no active attachment for checkpoint",
        );
      if (attachment.sandboxId !== input.sandboxId)
        throw new VolumePersistenceError(
          attachment.id,
          "checkpoint executor belongs to a different sandbox instance",
        );
      try {
        return await this.checkpoint({
          attachmentId: attachment.id,
          executor: input.executor,
        });
      } catch (error) {
        if (error instanceof ContainerReplacedError) {
          await service.applyWal(attachment.id);
          throw new VolumePersistenceError(
            attachment.id,
            "container replacement prevented a full checkpoint",
          );
        }
        throw error;
      }
    },

    /** Full-scan barrier + WAL application; run before a sandbox is deleted or a run ends. */
    async checkpoint(input: {
      attachmentId: string;
      executor: SandboxExecutor;
    }): Promise<ParsedExecuteResult> {
      const result = await input.executor.execute(
        this.wrapCommand("true", { full: true }),
        { timeoutMs: 600_000 },
      );
      return this.parseResult({
        attachmentId: input.attachmentId,
        output: result.output,
        exitCode: result.exitCode,
        executor: input.executor,
      });
    },

    isContainerReplacedError(error: unknown): boolean {
      return error instanceof ContainerReplacedError;
    },

    /** The container behind a sandbox id was replaced: apply what the old one uploaded and attach the new one. */
    async onContainerReplaced(input: {
      scope: VolumeScope;
      sandboxId: string;
      previousSandboxId?: string;
      executor: SandboxExecutor;
    }): Promise<AttachResult> {
      if (config.shadow) return this.attach(input);
      const volume = await service.repo.findVolume(input.scope);
      if (!volume) return this.attach(input);
      const previous = await service.repo.activeAttachment(volume.id);
      if (
        !previous ||
        previous.sandboxId !== (input.previousSandboxId ?? input.sandboxId)
      )
        throw new VolumePersistenceError(
          volume.id,
          "replacement does not match the previous active sandbox",
        );
      const attachment = await service.attach(volume.id, input.sandboxId, {
        expectedAttachmentId: previous.id,
      });
      return attachOnce(attachment, input.executor, []);
    },
  };
}

export type VolumeHooks = ReturnType<typeof createVolumeHooks>;
