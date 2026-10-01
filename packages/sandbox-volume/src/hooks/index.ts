import { EXIT_INSTANCE_CHANGED, EXIT_PACK_UNREADABLE, TAIL_MARKER } from "../protocol/constants";
import { parseCommandOutput } from "../protocol/marker";
import type { FlushReport } from "../protocol/types";
import type { AttachmentRow, VolumeScope } from "../service/repository";
import type { ApplyWalResult, VolumeService } from "../service/volume-service";

/** The one thing the hooks need from a sandbox: run a shell command and get its combined output and exit code. */
export type SandboxExecutor = {
  execute(command: string, options: { timeoutMs: number }): Promise<{ output: string; exitCode: number | null }>;
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
  constructor(readonly attachmentId: string) {
    super("the sandbox container was replaced; the volume must be re-attached before running commands");
  }
}

const DEFAULT_ROOT = "/workspace";

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

  async function bootstrapCommand(): Promise<string> {
    if (config.helper.imagePath) return `[ -x ${shellQuote(config.helper.imagePath)} ] || exit 90`;
    if (!config.helper.downloadUrl) throw new Error("no helper source configured");
    const url = await config.helper.downloadUrl();
    return `mkdir -p ${shellQuote(`${meta}/bin`)} && { [ -x ${shellQuote(helperPath)} ] || { curl -fsS --speed-limit 100000 --speed-time 5 --max-time 120 --retry 2 -o ${shellQuote(`${helperPath}.tmp`)} ${shellQuote(url)} && chmod 755 ${shellQuote(`${helperPath}.tmp`)} && mv ${shellQuote(`${helperPath}.tmp`)} ${shellQuote(helperPath)}; }; } || exit 90`;
  }

  async function attachOnce(attachment: AttachmentRow, executor: SandboxExecutor, repairs: Array<Record<string, unknown>>): Promise<AttachResult> {
    const started = Date.now();
    const files = await service.publishAttachFiles(attachment);
    const restore = config.shadow
      ? `${shellQuote(helperPath)} restore --root ${shellQuote(root)} --plan ${shellQuote(files.planUrl)} --index-only; rc=$?`
      : `${shellQuote(helperPath)} restore --root ${shellQuote(root)} --plan ${shellQuote(files.planUrl)}; rc=$?`;
    const command = [
      await bootstrapCommand(),
      `mkdir -p ${shellQuote(meta)}`,
      `if [ -f ${shellQuote(`${meta}/daemon.pid`)} ]; then kill "$(cat ${shellQuote(`${meta}/daemon.pid`)})" 2>/dev/null; sleep 0.2; fi`,
      `curl -fsS --speed-limit 20000 --speed-time 5 --max-time 60 --retry 2 -o ${shellQuote(`${meta}/slots.json`)} ${shellQuote(files.slotsUrl)} || exit 91`,
      restore,
      `[ "$rc" -eq 0 ] || exit "$rc"`,
      // stdin must not stay attached to the exec stream: the bridge would wait for the daemon to close it.
      `nohup setsid ${shellQuote(helperPath)} daemon --root ${shellQuote(root)} > ${shellQuote(`${meta}/daemon.log`)} 2>&1 < /dev/null &`,
      `for i in $(seq 1 50); do [ -S ${shellQuote(`${meta}/sock`)} ] && break; sleep 0.05; done`,
      `[ -S ${shellQuote(`${meta}/sock`)} ] && echo DAEMON_UP || echo DAEMON_DOWN`,
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
    if ((result.exitCode === 90 || result.exitCode === 91) && repairs.length < 3) {
      repairs.push({ bootstrapDownloadFailed: result.exitCode });
      log("volume.attach.bootstrap_retry", { attachmentId: attachment.id, exitCode: result.exitCode });
      return attachOnce(attachment, executor, repairs);
    }
    const unreadable = Array.isArray(info?.unreadable) ? (info!.unreadable as string[]) : [];
    if (result.exitCode === EXIT_PACK_UNREADABLE && unreadable.length && repairs.length < 3) {
      const repointed: string[] = [];
      for (const key of unreadable) repointed.push(await service.repairPack(attachment.volumeId, key));
      repairs.push({ unreadable, repointed });
      log("volume.attach.pack_repaired", { attachmentId: attachment.id, unreadable });
      return attachOnce(attachment, executor, repairs);
    }
    if (result.exitCode !== 0) {
      throw new Error(`volume attach failed (exit ${result.exitCode}): ${output.slice(-600)}`);
    }
    const bootId = typeof info?.boot_id === "string" ? info.boot_id : null;
    if (bootId) await service.recordBootId(attachment.id, bootId);
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
    async attach(input: { scope: VolumeScope; sandboxId: string; executor: SandboxExecutor }): Promise<AttachResult> {
      const volume = await service.getOrCreateVolume(input.scope);
      const attachment = await service.attach(volume.id, input.sandboxId);
      const result = await attachOnce(attachment, input.executor, []);
      log("volume.attach", { volumeId: volume.id, attachmentId: attachment.id, durationMs: result.durationMs, daemon: result.daemon, repairs: result.repairs.length });
      return result;
    },

    /**
     * Wrap a user command: identity check, the command, the sync barrier, one marker line.
     * The user command never runs in a replaced container (exit 75 instead).
     */
    wrapCommand(command: string, options: { full?: boolean } = {}): string {
      const check = `[ -x ${shellQuote(helperPath)} ] && ${shellQuote(helperPath)} check --root ${shellQuote(root)}`;
      const flush = `${shellQuote(helperPath)} flush --root ${shellQuote(root)}${options.full ? " --full" : ""} > ${shellQuote(`${meta}/last-flush.json`)} 2> ${shellQuote(`${meta}/last-flush.err`)}; __swvol_frc=$?`;
      return [
        `if ${check}; then`,
        `( ${command}\n); __swvol_rc=$?`,
        flush,
        `printf '\\n${TAIL_MARKER} %s %s\\n' "$__swvol_frc" "$(head -c 4000 ${shellQuote(`${meta}/last-flush.json`)})"`,
        `exit "$__swvol_rc"`,
        `else printf '\\n${TAIL_MARKER} ${EXIT_INSTANCE_CHANGED} {}\\n'; exit ${EXIT_INSTANCE_CHANGED}; fi`,
      ].join("\n");
    },

    /**
     * Strip the marker, apply the WAL, handle a rejected chain (rebase) and unreadable packs.
     * Throws ContainerReplacedError when the wrapper refused to run the command.
     */
    async parseResult(input: { attachmentId: string; output: string; exitCode: number | null; executor: SandboxExecutor }): Promise<ParsedExecuteResult> {
      const parsed = parseCommandOutput(input.output);
      if (parsed.instanceChanged) {
        log("volume.instance_changed", { attachmentId: input.attachmentId });
        throw new ContainerReplacedError(input.attachmentId);
      }
      const wal = await service.applyWal(input.attachmentId);
      let rebase: ParsedExecuteResult["sync"]["rebase"] = null;
      const slotTaken = parsed.flush ? JSON.stringify(parsed.flush).includes("MANIFEST_SLOT_TAKEN") : false;
      if (wal.rejected || slotTaken) {
        const { slotsUrl, head } = await service.beginRebase(input.attachmentId);
        const rb = await input.executor.execute(
          `curl -fsS --max-time 60 -o ${shellQuote(`${meta}/slots.json`)} ${shellQuote(slotsUrl)} && ${shellQuote(helperPath)} flush --root ${shellQuote(root)} --rebase ${head}`,
          { timeoutMs: 600_000 },
        );
        const wal2 = await service.applyWal(input.attachmentId);
        rebase = { applied: wal2.applied, stillRejected: wal2.rejected !== null };
        log("volume.rebase", { attachmentId: input.attachmentId, reason: wal.rejected ?? "slot taken", exitCode: rb.exitCode, applied: wal2.applied, stillRejected: rebase.stillRejected });
      }
      const repaired: string[] = [];
      const unreadable = Array.isArray(parsed.flush?.unreadable) ? parsed.flush!.unreadable! : [];
      if (unreadable.length) {
        const attachment = await service.repo.getAttachment(input.attachmentId);
        if (attachment) for (const key of unreadable) repaired.push(await service.repairPack(attachment.volumeId, key));
      }
      const flushOk = parsed.flushExitCode === 0 && (parsed.flush?.ok ?? true) !== false;
      const persisted = flushOk && !wal.rejected && (rebase === null || !rebase.stillRejected);
      return {
        output: parsed.output,
        exitCode: input.exitCode,
        sync: { persisted, flushExitCode: parsed.flushExitCode, flush: parsed.flush, wal, rebase, repaired },
      };
    },

    /** Full-scan barrier + WAL application; run before a sandbox is deleted or a run ends. */
    async checkpoint(input: { attachmentId: string; executor: SandboxExecutor }): Promise<ParsedExecuteResult> {
      const result = await input.executor.execute(this.wrapCommand("true", { full: true }), { timeoutMs: 600_000 });
      return this.parseResult({ attachmentId: input.attachmentId, output: result.output, exitCode: result.exitCode, executor: input.executor });
    },

    /** The container behind a sandbox id was replaced: apply what the old one uploaded and attach the new one. */
    async onContainerReplaced(input: { scope: VolumeScope; sandboxId: string; executor: SandboxExecutor }): Promise<AttachResult> {
      return this.attach(input);
    },
  };
}

export type VolumeHooks = ReturnType<typeof createVolumeHooks>;
