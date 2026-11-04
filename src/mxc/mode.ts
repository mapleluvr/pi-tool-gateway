import type { BackendCandidate } from "../backends.ts";

export interface MxcModeConfiguration {
  requested: boolean;
  candidate?: BackendCandidate;
  workspace: string;
  revision: string;
}
export interface MxcModeSnapshot {
  phase: "inactive" | "checking" | "ready" | "fallback";
  requested: boolean;
  eligible: boolean;
  generation: number;
  reason?: string;
}
export type MxcModeLease<T> =
  | { mode: "native"; generation: number; reason?: string }
  | { mode: "mxc"; generation: number; runtime: T };

export function isMxcShell(candidate?: BackendCandidate): boolean {
  if (!candidate || candidate.kind !== "powershell") return false;
  if (candidate.id === "pwsh7") return true;
  return candidate.id === "custom" && /(?:^|[\\/])pwsh(?:\.exe)?$/i.test(candidate.path) &&
    Number.parseInt(candidate.version ?? "", 10) >= 7;
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
  let onAbort!: () => void;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function createMxcModeController<T>(options: {
  check: (configuration: MxcModeConfiguration, signal: AbortSignal) => Promise<T>;
  platform?: string;
  checkTimeoutMs?: number;
  onChange?: (snapshot: MxcModeSnapshot) => void;
}) {
  let configuration: MxcModeConfiguration = { requested: false, workspace: "", revision: "" };
  let configurationKey = "";
  let generation = 0;
  let phase: MxcModeSnapshot["phase"] = "inactive";
  let reason: string | undefined;
  let runtime: T | undefined;
  let pending: { generation: number; controller: AbortController; promise: Promise<void> } | undefined;
  const platform = options.platform ?? process.platform;

  function eligible(): boolean {
    return platform === "win32" && isMxcShell(configuration.candidate);
  }
  function snapshot(): MxcModeSnapshot {
    return { phase, requested: configuration.requested, eligible: eligible(), generation, ...(reason ? { reason } : {}) };
  }
  function publish(next: MxcModeSnapshot["phase"], why?: string): void {
    phase = next;
    reason = why;
    options.onChange?.(snapshot());
  }
  function invalidate(): void {
    generation++;
    pending?.controller.abort(new Error("MXC configuration changed before execution"));
    pending = undefined;
    runtime = undefined;
    publish(configuration.requested && eligible() ? "checking" : "inactive");
  }
  function configure(next: MxcModeConfiguration): void {
    const key = JSON.stringify(next);
    if (key === configurationKey) return;
    configurationKey = key;
    configuration = {
      ...next,
      ...(next.candidate ? { candidate: { ...next.candidate, args: [...next.candidate.args] } } : {}),
    };
    invalidate();
  }

  function startCheck(): Promise<void> {
    if (pending?.generation === generation) return pending.promise;
    const ownGeneration = generation;
    const ownConfiguration = configuration;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const promise = (async () => {
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error("MXC availability check timed out");
            reject(error);
            controller.abort(error);
          }, options.checkTimeoutMs ?? 15_000);
        });
        const checked = await abortable(
          Promise.race([options.check(ownConfiguration, controller.signal), timeout]),
          controller.signal,
        );
        if (ownGeneration !== generation) return;
        runtime = checked;
        publish("ready");
      } catch (error) {
        if (ownGeneration !== generation) return;
        runtime = undefined;
        publish("fallback", error instanceof Error ? error.message : String(error));
      } finally {
        if (timer) clearTimeout(timer);
        if (pending?.generation === ownGeneration) pending = undefined;
      }
    })();
    pending = { generation: ownGeneration, controller, promise };
    return promise;
  }

  async function resolve(signal?: AbortSignal): Promise<MxcModeLease<T>> {
    if (signal?.aborted) throw new Error("Operation aborted");
    const ownGeneration = generation;
    if (configuration.requested && eligible() && phase === "checking") {
      await abortable(startCheck(), signal);
    }
    if (ownGeneration !== generation) throw new Error("MXC configuration changed before execution");
    if (phase === "ready" && runtime !== undefined) return { mode: "mxc", runtime, generation };
    return { mode: "native", generation, ...(phase === "fallback" ? { reason } : {}) };
  }

  function unavailable(ownGeneration: number, error: unknown): void {
    if (ownGeneration !== generation) return;
    invalidate();
    publish("fallback", error instanceof Error ? error.message : String(error));
  }

  function commit(next: MxcModeConfiguration, checked: T, expectedGeneration: number): void {
    if (expectedGeneration !== generation) throw new Error("MXC configuration changed before candidate commit");
    if (!next.requested || platform !== "win32" || !isMxcShell(next.candidate)) throw new Error("MXC candidate commit requires requested, eligible pwsh mode");
    configure(next);
    if (generation === expectedGeneration) invalidate();
    runtime = checked;
    publish("ready");
  }

  return { configure, snapshot, resolve, invalidate, unavailable, commit };
}
