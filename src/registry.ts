import { createWriteStream, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { BackendExecutor, ExecutionIdentity, ExecutionResult } from "./operations.ts";

export type TaskStatus = "running" | "done" | "failed" | "killed";

export interface BgTaskSnapshot {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: TaskStatus;
  exitCode: number | null;
  outputPath: string;
  startedAt: number;
  endedAt?: number;
  /** A rejected cancellation/cleanup is not an executor exit acknowledgement. */
  executionError?: string;
  execution?: ExecutionIdentity;
}

export interface StartOptions {
  cwd: string;
  name?: string;
  executor?: BackendExecutor;
  env?: NodeJS.ProcessEnv;
  execution?: ExecutionIdentity;
  onData?: (data: Buffer) => void;
}

export interface TaskRegistry {
  start(command: string, opts: StartOptions): Promise<BgTaskSnapshot>;
  get(idOrPrefix: string): BgTaskSnapshot;
  list(): BgTaskSnapshot[];
  logs(idOrPrefix: string, maxBytes?: number): Promise<string>;
  kill(idOrPrefix: string): Promise<BgTaskSnapshot>;
  waitFor(idOrPrefix: string, timeoutMs?: number): Promise<BgTaskSnapshot>;
  dispose(): void;
}

interface Internal {
  snapshot: BgTaskSnapshot;
  controller: AbortController;
  stream: WriteStream | undefined;
  killed: boolean;
  done: Promise<BgTaskSnapshot>;
  resolveDone: (t: BgTaskSnapshot) => void;
}

export const DEFAULT_LOGS_MAX_BYTES = 20_000;

export function formatCreated(
  task: Pick<BgTaskSnapshot, "id" | "name">,
): string {
  return [
    "background task created",
    `taskId: ${task.id}`,
    `name: ${task.name}`,
    `poll: bg_status {"taskId":"${task.id}"} · read: bg_logs · wait: bg_join · stop: bg_kill`,
  ].join("\n");
}

export function createTaskRegistry(opts: {
  dir: string;
  executor?: BackendExecutor;
}): TaskRegistry {
  const tasks = new Map<string, Internal>();

  function snapshotOf(t: Internal): BgTaskSnapshot {
    return { ...t.snapshot, ...(t.snapshot.execution ? { execution: { ...t.snapshot.execution } } : {}) };
  }

  function resolve(idOrPrefix: string): Internal {
    const exact = tasks.get(idOrPrefix);
    if (exact) return exact;
    const matches = [...tasks.values()].filter((t) =>
      t.snapshot.id.startsWith(idOrPrefix),
    );
    if (matches.length === 1) return matches[0];
    throw new Error(
      matches.length === 0
        ? `unknown task: ${idOrPrefix}`
        : `ambiguous task prefix: ${idOrPrefix}`,
    );
  }

  function settle(
    t: Internal,
    status: TaskStatus,
    exitCode: number | null,
  ): void {
    if (t.snapshot.status !== "running") return;
    t.snapshot = { ...t.snapshot, status, exitCode, endedAt: Date.now() };
    const settledSnapshot = snapshotOf(t);
    if (t.stream) {
      t.stream.end(() => t.resolveDone(settledSnapshot));
    } else {
      t.resolveDone(settledSnapshot);
    }
  }

  function settleExecution(t: Internal, result: ExecutionResult): void {
    if (t.killed || t.controller.signal.aborted) {
      settle(t, "killed", null);
    } else {
      settle(t, result.exitCode === 0 ? "done" : "failed", result.exitCode);
    }
  }

  async function start(
    command: string,
    startOpts: StartOptions,
  ): Promise<BgTaskSnapshot> {
    const id = randomBytes(4).toString("hex");
    const outputPath = join(opts.dir, `${id}.log`);
    const stream = createWriteStream(outputPath, { flags: "a" });
    let resolveDone!: (t: BgTaskSnapshot) => void;
    const done = new Promise<BgTaskSnapshot>((resolvePromise) => {
      resolveDone = resolvePromise;
    });
    const internal: Internal = {
      snapshot: {
        id,
        name: startOpts.name?.trim() || command.slice(0, 60) || id,
        command,
        cwd: startOpts.cwd,
        ...(startOpts.execution ? { execution: { ...startOpts.execution } } : {}),
        status: "running",
        exitCode: null,
        outputPath,
        startedAt: Date.now(),
      },
      controller: new AbortController(),
      stream,
      killed: false,
      done,
      resolveDone,
    };
    tasks.set(id, internal);

    const executor = startOpts.executor ?? opts.executor;
    if (!executor) {
      stream.write("\n[execution error: no backend executor configured]\n");
      settle(internal, "failed", null);
      return snapshotOf(internal);
    }

    let execution: Promise<ExecutionResult>;
    try {
      execution = executor.exec(command, startOpts.cwd, {
        onData: (data) => {
          stream.write(data);
          startOpts.onData?.(data);
        },
        signal: internal.controller.signal,
        env: startOpts.env,
      });
    } catch (error) {
      stream.write(
        `\n[spawn error: ${error instanceof Error ? error.message : String(error)}]\n`,
      );
      settle(internal, "failed", null);
      return snapshotOf(internal);
    }

    void execution
      .then((result) => settleExecution(internal, result))
      .catch((error: unknown) => {
        if (internal.killed || internal.controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          internal.snapshot = { ...internal.snapshot, executionError: message };
          if (!stream.writableEnded && !stream.destroyed) stream.write(`\n[execution error: ${message}]\n`);
          settle(internal, "killed", null);
          return;
        }
        stream.write(
          `\n[spawn error: ${error instanceof Error ? error.message : String(error)}]\n`,
        );
        settle(internal, "failed", null);
      });
    return snapshotOf(internal);
  }

  function get(idOrPrefix: string): BgTaskSnapshot {
    return snapshotOf(resolve(idOrPrefix));
  }

  function list(): BgTaskSnapshot[] {
    return [...tasks.values()]
      .map(snapshotOf)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  async function logs(
    idOrPrefix: string,
    maxBytes = DEFAULT_LOGS_MAX_BYTES,
  ): Promise<string> {
    const t = resolve(idOrPrefix);
    let content: string;
    try {
      content = await readFile(t.snapshot.outputPath, "utf8");
    } catch {
      return "";
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes <= maxBytes) return content;
    return content.slice(-maxBytes);
  }

  async function kill(idOrPrefix: string): Promise<BgTaskSnapshot> {
    const t = resolve(idOrPrefix);
    if (t.snapshot.status !== "running") return snapshotOf(t);
    t.killed = true;
    t.controller.abort();
    // Keep the native legacy budget. MXC only settles when exec acknowledges exit.
    if (t.snapshot.execution?.mode !== "mxc") setTimeout(() => settle(t, "killed", null), 1000).unref?.();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([t.done, new Promise((resolve) => { timer = setTimeout(resolve, 3000); })]);
    } catch {
      // Best effort; a still-running snapshot means cancellation is not confirmed.
    } finally { if (timer) clearTimeout(timer); }
    return snapshotOf(t);
  }

  async function waitFor(
    idOrPrefix: string,
    timeoutMs = 30_000,
  ): Promise<BgTaskSnapshot> {
    const t = resolve(idOrPrefix);
    if (t.snapshot.status !== "running") return snapshotOf(t);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        t.done,
        new Promise<BgTaskSnapshot>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`timed out waiting for task ${t.snapshot.id}`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function dispose(): void {
    for (const t of tasks.values()) {
      if (t.snapshot.status === "running") {
        t.killed = true;
        t.controller.abort();
      }
    }
  }

  return { start, get, list, logs, kill, waitFor, dispose };
}
